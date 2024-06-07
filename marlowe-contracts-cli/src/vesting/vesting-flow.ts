import { Blockfrost, Lucid } from "lucid-cardano";
import { readConfig } from "../../config.js";
import {
  AddressBech32,
  StakeAddressBech32,
  addressBech32,
  contractId,
  contractIdToTxId,
  stakeAddressBech32,
} from "@marlowe.io/runtime-core";
import { WalletAPI, mkLucidWallet } from "@marlowe.io/wallet";
import { mkRuntimeLifecycle } from "@marlowe.io/runtime-lifecycle";
import { CanAdvance, CanDeposit, ContractInstanceAPI, RuntimeLifecycle } from "@marlowe.io/runtime-lifecycle/api";
import { input, select } from "@inquirer/prompts";
import { bech32Validator, dateInFutureValidator, positiveBigIntValidator, waitIndicator } from "../utils/utils.js";
import { SourceMap, mkSourceMap } from "../utils/experimental-features/source-map.js";
import { datetoTimeout } from "@marlowe.io/language-core-v1";
import {
  ProjectAnnotations,
  ProjectParameters,
  projectGetActions,
  projectGetState,
  projectMetadata,
  projectStatePlus,
  projectTag,
  projectTemplate,
  projectValidation,
  mkProject,
} from "./vesting.js";
import { ContractHeader, GetContractsRequest, mintRole } from "@marlowe.io/runtime-rest-client/contract";

// When this script is called, start with main.
main();

async function main() {
  const config = await readConfig();
  const lucidNami = await Lucid.new(new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId), config.network);
  const lucidLace = await Lucid.new(new Blockfrost(config.blockfrostUrl, config.blockfrostProjectId), config.network);
  lucidNami.selectWalletFromSeed(config.seedPhraseNami);
  lucidLace.selectWalletFromSeed(config.seedPhraseLace);
  const rewardAddressStr = await lucidNami.wallet.rewardAddress();
  const rewardAddress = rewardAddressStr ? stakeAddressBech32(rewardAddressStr) : undefined;
  const runtimeURL = config.runtimeURL;

  const walletNami = mkLucidWallet(lucidNami);
  const walletLace = mkLucidWallet(lucidLace);

  const lifecycleNami = mkRuntimeLifecycle({
    runtimeURL,
    wallet: walletNami,
  });
  const lifecycleLace = mkRuntimeLifecycle({
    runtimeURL,
    wallet: walletLace,
  });
  try {
    await mainLoop(lifecycleNami, lifecycleLace, rewardAddress);
  } catch (e) {
    console.log(`Error : ${JSON.stringify(e, null, 4)}`);
  }
}

async function mainLoop(lifecycleNami: RuntimeLifecycle, lifecycleLace: RuntimeLifecycle, rewardAddress?: StakeAddressBech32) {
  try {
    while (true) {
      const address = (await lifecycleNami.wallet.getUsedAddresses())[0];
      console.log("Wallet address:", address);
      console.log("Reward address:", rewardAddress);
      const action = await select({
        message: "Main menu",
        choices: [
          { name: "Create a contract", value: "create" },
          { name: "Load a contract", value: "load" },
          { name: "See contracts", value: "download" },
          { name: "Exit", value: "exit" },
        ],
      });
      switch (action) {
        case "create":
          await createContractMenu(lifecycleNami, lifecycleLace, rewardAddress);
          break;
        case "load":
          await loadContractMenu(lifecycleLace, lifecycleNami);
          break;
        case "download":
          await downloadMenu(lifecycleLace);
          break;
        case "exit":
          process.exit(0);
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("closed the prompt")) {
      process.exit(0);
    }
    if (e instanceof Error) {
      console.error(e.message);
      process.exit(1);
    } else {
      throw e;
    }
  }
}

export async function downloadMenu(lifecycleNami: RuntimeLifecycle) {
  const tags_array = ["CONTRACT_VERSION_3"];

  //Address option
  const [walletAddress] = await lifecycleNami.wallet.getUsedAddresses();
  const contractsRequest: GetContractsRequest = {
    tags: tags_array,
  };
  const contractHeaders = await lifecycleNami.restClient.getContracts(contractsRequest);
  const contractHeadersContracts = contractHeaders.contracts;
  // console.log(contractHeadersContracts);

  const contractHeaderFilteredByOpenRole = await Promise.all(
    contractHeadersContracts.map(async (item) => {
      try {        
        const contractInstance = await lifecycleNami.newContractAPI.load(item.contractId);
        const details = await contractInstance.getDetails();
        if (details.type === "closed") {return undefined}
        const history = await contractInstance.getInputHistory();
        const applicableActions =
        await lifecycleNami.applicableActions.getApplicableActions(
          details
        );
        const depositAvailable = applicableActions.some(item => item.type === "Deposit") 
        
        if(history.length === 0 && depositAvailable) {return item}
        
        // console.log("details type",details.type);
        // console.log("history",history.length);
        // console.log("applicableActions",applicableActions)
        // console.log("depositAvailable",depositAvailable)
      } catch (error) {
        return undefined;
      }
    })
  );
  console.log("contractHeaderFilteredByOpenRole",contractHeaderFilteredByOpenRole)

  //Filter token option
  // const contractsRequest: GetContractsRequest = {
  //   tags: tags_array,
  // };
  // const contractHeaders = await lifecycleNami.restClient.getContracts(contractsRequest);
  // const walletTokens = await lifecycleNami.wallet.getTokens();
  // const tokenAssetName = "payer" as string;

  // //filter those contracts that have Policy ID, if they dont have one they have ""
  // const filteredByRoleTokenMintingPolicy = contractHeaders.contracts.filter((header) => header.roleTokenMintingPolicyId);
  // console.log("filteredByRoleTokenMintingPolicy", filteredByRoleTokenMintingPolicy);

  // //predicate
  // const filteredByWalletTokens = (header: ContractHeader): boolean => {
  //   return walletTokens.some(
  //     (item) => item.assetId.policyId === header.roleTokenMintingPolicyId && item.assetId.assetName === tokenAssetName
  //   );
  // };

  // //filter by tokens on the wallet
  // const contractHeaderFilteredByWallet = filteredByRoleTokenMintingPolicy.filter((header) => filteredByWalletTokens(header));
  // console.log("contractHeaderFilteredByWallet", contractHeaderFilteredByWallet);

  await Promise.all(
    contractHeaderFilteredByOpenRole.map(async (item) => {
      if (item === undefined) {return null}
      try {
        const result = await projectValidation(lifecycleNami, item.contractId);
        if (result === "InvalidMarloweTemplate" || result === "InvalidContract") {
          // throw new Error("invalid");
          console.log("invalid");
          return;
        }
        const contractInstance = await lifecycleNami.newContractAPI.load(item.contractId);
        const details = await contractInstance.getDetails();
        console.log("details", details);
        const inputHistory = await contractInstance.getInputHistory();
        const contractState = projectGetState(datetoTimeout(new Date()), inputHistory, result.sourceMap);
        console.log("contractState", contractState);
        if (contractState.type !== "Closed") {
          projectStatePlus(contractState, result.scheme);
          const applicableActions = await contractInstance.evaluateApplicableActions();
          const choices = projectGetActions(applicableActions, contractState);
          console.log("choices", choices);
        }
      } catch (error) {
        console.log("error", error);
      }
    })
  );
}

/**
 * This is an Inquirer.js flow to create a contract
 * @param lifecycle An instance of the RuntimeLifecycle
 * @param rewardAddress An optional reward address to stake the contract rewards
 */
export async function createContractMenu(
  lifecycleNami: RuntimeLifecycle,
  lifecycleLace: RuntimeLifecycle,
  rewardAddress?: StakeAddressBech32
) {
  const payer = addressBech32(
    await input({
      message: "Enter the VC address",
      validate: bech32Validator,
    })
  );
  const amountStr = await input({
    message: "Enter the payment amount in lovelaces",
    validate: positiveBigIntValidator,
  });

  const amount = BigInt(amountStr);

  const depositDeadlineStr = await input({
    message: "Enter the deposit deadline",
    validate: dateInFutureValidator,
  });
  const depositDeadline = new Date(depositDeadlineStr);

  const releaseDeadlineStr = await input({
    message: "Enter the deposit deadline",
    validate: dateInFutureValidator,
  });
  const releaseDeadline = new Date(releaseDeadlineStr);

  const projectName = await input({
    message: "Enter the project name",
  });

  const githubUrl = await input({
    message: "Enter the githubUrl",
  });

  const walletAddress = (await lifecycleNami.wallet.getUsedAddresses())[0];
  console.log(`Fund my project:\n * from  ${payer}\n * to ${walletAddress}\n * for ${amount} lovelaces\n`);
  if (rewardAddress) {
    console.log(`In the meantime, the contract will stake rewards to ${rewardAddress}`);
  }

  const scheme: ProjectParameters = {
    payer,
    payee: walletAddress,
    amount,
    depositDeadline,
    releaseDeadline,
    projectName,
    githubUrl,
  };
  const tokenMetadata = {
    name: "VC Token",
    description: "These tokens give access to deposit on the contract",
    image: "ipfs://QmaQMH7ybS9KmdYQpa4FMtAhwJH5cNaacpg4fTwhfPvcwj",
    mediaType: "image/png",
    files: [
      {
        name: "icon-1000",
        mediaType: "image/webp",
        src: "ipfs://QmUbvavFxGSSEo3ipQf7rjrELDvXHDshWkHZSpV8CVdSE5",
      },
    ],
  };
  const metadata = projectTemplate.toMetadata(scheme);
  const sourceMap = await mkSourceMap(lifecycleNami, mkProject(scheme));
  const contractInstance = await sourceMap.createContract({
    stakeAddress: rewardAddress,
    tags: projectTag,
    metadata,
    roles: { payer: mintRole("OpenRole", 1n, tokenMetadata) },
  });

  console.log(`Contract created with id ${contractInstance.id}`);

  // this is another option to wait for a tx when using the instance of the contract
  // await contractInstance.waitForConfirmation();
  await waitIndicator(lifecycleNami.wallet, contractIdToTxId(contractInstance.id));

  console.log(`Contract id ${contractInstance.id} was successfully submited to the blockchain`);

  return contractMenu(lifecycleNami.wallet, lifecycleLace.wallet, contractInstance, scheme, sourceMap, lifecycleLace);
}

/**
 * This is an Inquirer.js flow to load an existing contract
 * @param lifecycle
 * @returns
 */
async function loadContractMenu(lifecycleLace: RuntimeLifecycle, lifecycleNami: RuntimeLifecycle) {
  // First we ask the user for a contract id
  const cidStr = await input({
    message: "Enter the contractId",
  });
  const cid = contractId(cidStr);
  // Then we make sure that contract id is an instance of our fund my project contract
  const validationResult = await projectValidation(lifecycleLace, cid);
  if (validationResult === "InvalidMarloweTemplate") {
    console.log("Invalid contract, it does not have the expected tags");
    return;
  }
  if (validationResult === "InvalidContract") {
    console.log("Invalid contract, it does not have the expected contract source");
    return;
  }

  // If it is, we print the contract details and go to the contract menu
  console.log("Contract details:");
  console.log(`  * Pay from: ${validationResult.scheme.payer}`);
  console.log(`  * Pay to: ${validationResult.scheme.payee}`);
  console.log(`  * Amount: ${validationResult.scheme.amount} lovelaces`);
  console.log(`  * Deposit deadline: ${validationResult.scheme.depositDeadline}`);
  console.log(`  Project Name: ${validationResult.scheme.projectName}`);
  console.log(`  Project Github: ${validationResult.scheme.githubUrl}`);
  const contractInstance = await lifecycleLace.newContractAPI.load(cid);
  return contractMenu(
    lifecycleNami.wallet,
    lifecycleLace.wallet,
    contractInstance,
    validationResult.scheme,
    validationResult.sourceMap,
    lifecycleLace
  );
}

/**
 * This is an Inquirer.js flow to interact with a contract
 */
async function contractMenu(
  walletNami: WalletAPI,
  walletLace: WalletAPI,
  contractInstance: ContractInstanceAPI,
  scheme: ProjectParameters,
  sourceMap: SourceMap<ProjectAnnotations>,
  lifecycleLace: RuntimeLifecycle
): Promise<void> {
  const inputHistory = await contractInstance.getInputHistory();
  const details = await contractInstance.getDetails();
  if (details.type === "closed") {
    return;
  }
  // console.log({ inputHistory });

  const contractState = projectGetState(datetoTimeout(new Date()), inputHistory, sourceMap);
  // console.log({ contractState });

  if (contractState.type === "Closed") return;

  projectStatePlus(contractState, scheme);
  // See what actions are applicable to the current contract state
  const applicableActions = await contractInstance.evaluateApplicableActions();
  //   console.log({ applicableActions });

  const choices = projectGetActions(applicableActions, contractState);

  const selectedAction = await select({
    message: "Contract menu",
    choices,
  });
  switch (selectedAction.type) {
    case "check-state":
      return contractMenu(walletNami, walletLace, contractInstance, scheme, sourceMap, lifecycleLace);
    case "return":
      return;
    case "Advance":
    case "Deposit":
      console.log("Applying input");
      const applicableInput = await applicableActions.toInput(selectedAction);
      console.log("applicableInput", applicableInput);

      //modern way
      const txId = await applicableActions.apply({
        input: applicableInput,
      });

      //old way
      // const txId = await lifecycleLace.applicableActions.applyInput(details.contractId, {
      //   input: applicableInput,
      // })

      console.log(`Input applied with txId ${txId}`);
      await waitIndicator(walletLace, txId);
      return contractMenu(walletNami, walletLace, contractInstance, scheme, sourceMap, lifecycleLace);
  }
}
