$env:GH_BROWSER = 'echo'
Start-Process -FilePath 'D:\GFA-runtime\gh\bin\gh.exe' -ArgumentList 'auth','login','--hostname','github.com','--git-protocol','https','--web','--skip-ssh-key' -RedirectStandardOutput 'D:\GFA-runtime\gh\device-login.out' -RedirectStandardError 'D:\GFA-runtime\gh\device-login.err' -WindowStyle Hidden
