$env:SSH_ASKPASS = "c:\Users\Administrator\Desktop\GFA\ssh_pass.cmd"
$env:SSH_ASKPASS_REQUIRE = "force"
$env:DISPLAY = "dummy"
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -p 1958 root@154.12.88.124 "whoami && docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' && echo '===DIR===' && find /root /opt /home -maxdepth 3 -type d -name '*api*' 2>/dev/null && echo '===COMPOSE===' && find / -maxdepth 4 -name 'docker-compose*' 2>/dev/null | head -20"
