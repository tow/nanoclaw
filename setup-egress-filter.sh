#!/bin/bash
set -e

NETWORK_NAME="nanoclaw-restricted"

docker network rm $NETWORK_NAME 2>/dev/null || true
docker network create --driver bridge --subnet 172.30.0.0/24 $NETWORK_NAME

BRIDGE="br-$(docker network inspect $NETWORK_NAME -f '{{.Id}}' | head -c 12)"
echo "Bridge interface: $BRIDGE"

# Default: drop all outbound from this network
iptables -I DOCKER-USER 1 -i $BRIDGE -j DROP

# Allow established connections (responses)
iptables -I DOCKER-USER 1 -i $BRIDGE -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# Allow DNS
iptables -I DOCKER-USER 1 -i $BRIDGE -p udp --dport 53 -j ACCEPT

# Allow HTTPS to api.anthropic.com
for ip in $(dig +short api.anthropic.com); do
  iptables -I DOCKER-USER 1 -i $BRIDGE -p tcp --dport 443 -d $ip -j ACCEPT
done

# Allow HTTPS to github.com
for ip in $(dig +short github.com); do
  iptables -I DOCKER-USER 1 -i $BRIDGE -p tcp --dport 443 -d $ip -j ACCEPT
done

# Allow access to host (OneCLI gateway)
iptables -I DOCKER-USER 1 -i $BRIDGE -d 172.30.0.1 -j ACCEPT
HOST_IP=$(ip -4 addr show docker0 | grep -oP '(?<=inet\s)\d+(\.\d+){3}')
if [ -n "$HOST_IP" ]; then
  iptables -I DOCKER-USER 1 -i $BRIDGE -d $HOST_IP -j ACCEPT
fi

echo "Egress filter applied: api.anthropic.com, github.com, DNS, host only"
