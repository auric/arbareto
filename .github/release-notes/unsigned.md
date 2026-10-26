## Unsigned build

This build has no code signature.

- Windows SmartScreen can show "Windows protected your PC" when you start the installer. To continue, select "More info", then "Run anyway".
- Unsigned builds do not run when Smart App Control is on. You cannot allow a single file in Smart App Control.

Check each download before you install it. In PowerShell, compare this value with the line for the file in `SHA256SUMS.txt`:

```powershell
(Get-FileHash .\<file> -Algorithm SHA256).Hash
```

With `sha256sum`, run this command in the folder of the downloads:

```sh
sha256sum --check SHA256SUMS.txt
```

To check that the release workflow of this repository built the file, use the GitHub CLI:

```sh
gh attestation verify <file> -R auric/arbareto
```
