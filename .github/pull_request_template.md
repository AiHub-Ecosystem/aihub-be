## Release compatibility

- [ ] This PR adds no persisted enum/value, runtime configuration variable, or Vault template key.
- [ ] If it adds a persisted enum/value, this release only teaches readers to accept or safely skip it; a later release starts writing it after the reader is deployed.
- [ ] If it adds configuration or a Vault key, this release keeps existing keys; any strict Vault reader follows the coordinated cutover and rollback procedure.
- [ ] If it removes or renames a key/value, no deployed image still reads it, or the approved contract migration and rollback plan is linked here.
