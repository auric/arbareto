## Code signing policy

This section is a placeholder. It gets the SignPath Foundation text, the team roles, and the privacy statement before the first signed release.

- The installer, `arbareto.exe`, and `arbareto-git.exe` carry a code signature.
- The uninstaller and the NSIS plugin DLL inside the installer have no code signature.

Check each download before you install it:

```sh
sha256sum --check SHA256SUMS.txt
gh attestation verify <file> -R auric/arbareto
```
