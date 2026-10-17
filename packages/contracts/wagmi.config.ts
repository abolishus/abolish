// Typed ABI bindings for the deployable contracts (contracts skill, Bindings;
// brief: "Contract ABIs → typed bindings via the wagmi CLI Foundry plugin").
// The package build compiles first, so the plugin only reads `out/`. Only the
// eight deployable contracts are listed: test harnesses, fixtures and vendored
// libraries in `out/` are not part of the deployed interface.
import { defineConfig } from "@wagmi/cli";
import { foundry } from "@wagmi/cli/plugins";

export default defineConfig({
  out: "src/generated/abi.ts",
  plugins: [
    foundry({
      forge: { build: false, rebuild: false },
      include: [
        "BallotRelay.sol/BallotRelay.json",
        "Board.sol/Board.json",
        "BoardAnchor.sol/BoardAnchor.json",
        "ElectionRegistry.sol/ElectionRegistry.json",
        "GroupRegistry.sol/GroupRegistry.json",
        "RegistrationAccount.sol/RegistrationAccount.json",
        "RegistrationPaymaster.sol/RegistrationPaymaster.json",
        "TrusteeRegistry.sol/TrusteeRegistry.json",
      ],
    }),
  ],
});
