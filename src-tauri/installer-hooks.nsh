!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME} (Unsigned local test package)"
!macroend
