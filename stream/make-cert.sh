#!/bin/sh
# Crea il certificato del convertitore quando ci arrivi con un indirizzo IP (per esempio con la VPN) e quindi nessuna autorità
# pubblica può rilasciartene uno. Si fa una piccola autorità di certificazione (CA) che vale SOLO per quell'indirizzo: la installi
# una volta sull'iPhone (vedi README) e da lì in poi wss://INDIRIZZO:8090 è considerato sicuro dal browser.
#
# Uso:   ./make-cert.sh 10.8.0.1                 (un indirizzo; si possono scrivere più indirizzi o nomi, separati da spazi)
#        DAYS=825 ./make-cert.sh 192.168.1.20 10.8.0.1
#
# Crea:  certs/server.crt e certs/server.key   → li legge il contenitore (cartella montata in sola lettura)
#        ca/volleylive-ca.crt                  → il file da installare sul telefono (non è segreto; copia anche in certs/, il convertitore lo offre su /ca.crt)
#        ca/ca.key                             → la chiave della CA: NON copiarla sul telefono, meglio toglierla dal NAS dopo l'uso
# La CA ha il vincolo «solo questi indirizzi»: anche se la sua chiave finisse in mani sbagliate non può certificare altri siti.
# Se la CA esiste già per gli stessi indirizzi viene riusata: per rinnovare il certificato non serve reinstallare nulla sul telefono.
set -eu

[ "$#" -ge 1 ] || { echo "Uso: $0 INDIRIZZO-IP [altri indirizzi o nomi...]" >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "Serve openssl (sul Synology c'è: usa SSH)." >&2; exit 1; }

here=$(cd "$(dirname "$0")" && pwd)
ca="$here/ca"; out="$here/certs"
DAYS="${DAYS:-825}"; CA_DAYS="${CA_DAYS:-3650}"
mkdir -p "$ca" "$out"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

is_ip() { printf '%s' "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; }
san=""; n=0; names=""
for h in "$@"; do
  if is_ip "$h"; then
    for o in $(printf '%s' "$h" | tr '.' ' '); do [ "$o" -le 255 ] || { echo "Indirizzo non valido: $h" >&2; exit 1; }; done
    n=$((n+1)); san="$san${san:+,}IP.$n:$h"
  else
    printf '%s' "$h" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' || { echo "Nome non valido: $h" >&2; exit 1; }
    n=$((n+1)); san="$san${san:+,}DNS.$n:$h"
  fi
  names="$names${names:+ }$h"
done
# elenco usato per riconoscere se la CA esistente vale ancora
echo "$names" > "$tmp/names"

# ---- CA (si riusa se è per gli stessi indirizzi)
if [ -f "$ca/ca.key" ] && [ -f "$ca/volleylive-ca.crt" ] && [ -f "$ca/names.txt" ] && [ "$(cat "$ca/names.txt")" = "$names" ]; then
  echo "Riuso la CA esistente (stessi indirizzi: $names)."
else
  {
    echo "[req]"; echo "distinguished_name=dn"; echo "x509_extensions=ext"; echo "prompt=no"
    echo "[dn]"; echo "CN=VolleyLive CA (solo $names)"
    echo "[ext]"
    echo "basicConstraints=critical,CA:TRUE,pathlen:0"
    echo "keyUsage=critical,keyCertSign,cRLSign"
    echo "subjectKeyIdentifier=hash"
    echo "nameConstraints=critical,@nc"
    echo "[nc]"
    i=0; for h in "$@"; do
      i=$((i+1))
      if is_ip "$h"; then echo "permitted;IP.$i=$h/255.255.255.255"; else echo "permitted;DNS.$i=$h"; fi
    done
  } > "$tmp/ca.cnf"
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$ca/ca.key" -out "$ca/volleylive-ca.crt" -days "$CA_DAYS" -sha256 -config "$tmp/ca.cnf" 2>/dev/null
  chmod 600 "$ca/ca.key"; cp "$tmp/names" "$ca/names.txt"
  echo "Creata una nuova CA: va installata sul telefono (ca/volleylive-ca.crt)."
fi

# ---- certificato del convertitore
{
  echo "[req]"; echo "distinguished_name=dn"; echo "prompt=no"
  echo "[dn]"; echo "CN=VolleyLive convertitore"
} > "$tmp/srv.cnf"
{
  echo "basicConstraints=critical,CA:FALSE"
  echo "keyUsage=critical,digitalSignature,keyEncipherment"
  echo "extendedKeyUsage=serverAuth"
  echo "subjectAltName=$san"
} > "$tmp/srv.ext"
openssl req -new -newkey rsa:2048 -nodes -keyout "$out/server.key" -out "$tmp/srv.csr" -config "$tmp/srv.cnf" 2>/dev/null
openssl x509 -req -in "$tmp/srv.csr" -CA "$ca/volleylive-ca.crt" -CAkey "$ca/ca.key" -CAcreateserial -CAserial "$tmp/ca.srl" -out "$out/server.crt" -days "$DAYS" -sha256 -extfile "$tmp/srv.ext" 2>/dev/null
cp "$ca/volleylive-ca.crt" "$out/volleylive-ca.crt"    # copia pubblica: il convertitore la offre su /ca.crt per installarla sul telefono
chmod 644 "$out/server.crt" "$out/server.key" "$out/volleylive-ca.crt"    # il contenitore gira con un utente non root e deve poter leggere la chiave

# ---- controllo: il certificato deve essere accettato per questi indirizzi
for h in "$@"; do
  if is_ip "$h"; then chk="-verify_ip $h"; else chk="-verify_hostname $h"; fi
  # shellcheck disable=SC2086
  openssl verify -CAfile "$ca/volleylive-ca.crt" -purpose sslserver $chk "$out/server.crt" >/dev/null || { echo "Il controllo del certificato per $h è fallito." >&2; exit 1; }
done
echo "Certificato creato per: $names (valido fino al $(openssl x509 -in "$out/server.crt" -noout -enddate | cut -d= -f2))."
echo "  per il convertitore:  certs/server.crt  certs/server.key   (nel .env: TLS_CERT=/certs/server.crt  TLS_KEY=/certs/server.key)"
echo "  per il telefono:      con la VPN accesa apri in Safari  https://$1:8090/ca.crt  (dopo aver avviato il convertitore), oppure usa il file ca/volleylive-ca.crt"
