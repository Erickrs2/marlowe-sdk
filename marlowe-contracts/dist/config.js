import * as t from "io-ts/lib/index.js";
import { configJson } from './configJson.js';
const lucidNetworkGuard = t.union([
    t.literal("Mainnet"),
    t.literal("Preview"),
    t.literal("Preprod"),
    t.literal("Custom"),
]);
const configGuard = t.type({
    blockfrostProjectId: t.string,
    blockfrostUrl: t.string,
    network: lucidNetworkGuard,
    seedPhraseNami: t.string,
    seedPhraseLace: t.string,
    runtimeURL: t.string,
});
export async function readConfig() {
    const result = configGuard.decode(configJson);
    if (result._tag === "Left") {
        throw new Error("Invalid config.json");
    }
    return result.right;
}
//# sourceMappingURL=config.js.map