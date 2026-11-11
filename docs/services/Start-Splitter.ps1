# Run under the account that owns the password file. This file contains no secret.
$ErrorActionPreference = 'Stop'
$env:ICOM_RADIO_HOST = '10.0.1.25'
$env:ICOM_USERNAME = 'your-radio-user'
$env:ICOM_PASSWORD_FILE = "$env:USERPROFILE\.config\icom-splitter\password"
$env:ICOM_BIND_ADDRESS = '192.168.1.20'
Set-Location 'C:\icom-splitter'
& '.\icom-lan-splitter.exe' '--headless'
# Source checkout alternative (replace the command above):
# & 'C:\Program Files\nodejs\node.exe' '.\src\cli.js' '--headless'
exit $LASTEXITCODE
