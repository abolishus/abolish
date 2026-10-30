# Deployments

`script/Deploy.s.sol` writes one record per chain here, `<chain-id>.json`. Each record gives the deployment's target (`staging`, the only one the script deploys while any of [[0044-testnet-deployments]]'s conditions is open), the chain, the deployer and its starting nonce, the commit deployed, and each contract's address and runtime code hash. The L2 record also gives the launch panel's identifier.

The deploy workflow ([[P2-32]] part 3) commits the records for Base Sepolia (`84532.json`) and Sepolia (`11155111.json`). The local Anvil pair's records (`31337.json`, `31338.json`), which `test/deploy.test.ts` writes, are ignored.
