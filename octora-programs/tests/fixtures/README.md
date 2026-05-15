# Test Fixtures

Drop dumped Solana program binaries here. They are loaded into the local
validator by `Anchor.toml` `[[test.genesis]]` so executor CPIs land on the
real program logic.

## Meteora DLMM (`meteora_dlmm.so`)

Mainnet program ID: `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`

Dump it once and commit the binary (or fetch in CI):

```bash
solana program dump -u m LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo \
  tests/fixtures/meteora_dlmm.so
```

The dump is ~700 KB. Re-dump whenever Meteora upgrades — the program ID is
upgrade-authority-controlled, so a redeploy on mainnet means our cached
binary is stale and the CPI account schemas may have shifted.
