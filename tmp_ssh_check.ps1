$env:TERM = "dumb"
$commands = @"
echo '===ENV_START==='
cat /root/sub2api-deploy/.env 2>/dev/null || echo 'NO_DEPLOY_ENV'
echo '===ENV_END==='
echo '===DOCKER_START==='
docker ps --format '{{.Names}} {{.Image}} {{.Status}}' 2>/dev/null || echo 'NO_DOCKER'
echo '===DOCKER_END==='
echo '===SYSTEMD_START==='
systemctl status sub2api 2>/dev/null || echo 'NO_SYSTEMD'
echo '===SYSTEMD_END==='
echo '===OPT_START==='
ls /opt/sub2api/ 2>/dev/null || echo 'NO_OPT'
echo '===OPT_END==='
echo '===CONFIG_START==='
cat /opt/sub2api/config.yaml 2>/dev/null || echo 'NO_CONFIG'
echo '===CONFIG_END==='
echo '===INSTALL_START==='
cat /root/sub2api-deploy/docker-compose.yml 2>/dev/null || echo 'NO_COMPOSE'
echo '===INSTALL_END==='
"@

# Write commands to a temp file
$commands | Out-File -FilePath "c:\Users\Administrator\Desktop\GFA\tmp_ssh_cmds.sh" -Encoding ascii -NoNewline

# Use ssh with password from file approach
$process = Start-Process -FilePath "ssh" -ArgumentList "-o","StrictHostKeyChecking=no","-o","ConnectTimeout=15","-o","BatchMode=yes","-p","1958","root@154.12.88.124","bash -s" -RedirectStandardInput "c:\Users\Administrator\Desktop\GFA\tmp_ssh_cmds.sh" -RedirectStandardOutput "c:\Users\Administrator\Desktop\GFA\tmp_ssh_output.txt" -RedirectStandardError "c:\Users\Administrator\Desktop\GFA\tmp_ssh_error.txt" -NoNewWindow -PassThru -Wait

Write-Host "Exit code: $($process.ExitCode)"
Write-Host "=== OUTPUT ==="
Get-Content "c:\Users\Administrator\Desktop\GFA\tmp_ssh_output.txt" -ErrorAction SilentlyContinue
Write-Host "=== ERROR ==="
Get-Content "c:\Users\Administrator\Desktop\GFA\tmp_ssh_error.txt" -ErrorAction SilentlyContinue
