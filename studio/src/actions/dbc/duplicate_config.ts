import { Connection, PublicKey, Keypair, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  getDbcConfig,
  parseCliArguments,
  safeParseKeypairFromFile,
  modifyComputeUnitPriceIx,
  runSimulateTransaction,
} from '../../helpers';
import {
  DEVNET_RPC_URL,
  MAINNET_RPC_URL,
  LOCALNET_RPC_URL,
  DEFAULT_COMMITMENT_LEVEL,
  DEFAULT_SEND_TX_MAX_RETRIES,
} from '../../utils/constants';
import { getDbcConfigByAddress, getDbcPoolConfigByPoolAddress } from '../../lib/dbc';
import {
  DynamicBondingCurveClient,
  buildCurveWithCustomSqrtPrices,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { Wallet } from '@coral-xyz/anchor';
import BN from 'bn.js';
import Decimal from 'decimal.js';

async function main() {
  const config = await getDbcConfig();

  const { network, poolAddress, config: configPublicKey } = parseCliArguments();
  if (!poolAddress && !configPublicKey) {
    throw new Error('Please provide either --poolAddress or --config flag to do this action');
  }

  let rpcUrl;
  switch (network?.toLowerCase()) {
    case 'devnet':
      rpcUrl = DEVNET_RPC_URL;
      break;
    case 'mainnet':
      rpcUrl = MAINNET_RPC_URL;
      break;
    case 'localnet':
      rpcUrl = LOCALNET_RPC_URL;
      break;
    default:
      rpcUrl = config.rpcUrl;
      break;
  }

  console.log('\n> Initializing configuration...');
  if (poolAddress) {
    console.log(`- Using pool address ${poolAddress} and RPC URL ${rpcUrl}`);
  }
  if (configPublicKey) {
    console.log(`- Using config public key ${configPublicKey} and RPC URL ${rpcUrl}`);
  }

  const connection = new Connection(rpcUrl, DEFAULT_COMMITMENT_LEVEL);
  const keypair = await safeParseKeypairFromFile(config.keypairFilePath);
  const wallet = new Wallet(keypair);

  try {
    let result;
    if (configPublicKey) {
      result = await getDbcConfigByAddress(connection, new PublicKey(configPublicKey));
    } else if (poolAddress) {
      result = await getDbcPoolConfigByPoolAddress(connection, new PublicKey(poolAddress));
    }

    if (result) {
      const { poolConfig: rawPoolConfig } = result;
      const poolConfig = rawPoolConfig as any;
      console.log(`\n> Fetched DBC Pool Config:`);
      console.log(JSON.stringify(poolConfig, null, 2));

      if (!config.dbcConfig) {
        throw new Error('Missing dbcConfig in local dbc_config.jsonc for substitutions');
      }

      const feeClaimer = config.dbcConfig.feeClaimer;
      const leftoverReceiver = config.dbcConfig.leftoverReceiver;

      console.log('\n> Duplicating config with substitutions:');
      console.log(`- Payer: ${wallet.publicKey.toString()}`);
      console.log(`- Fee Claimer: ${feeClaimer}`);
      console.log(`- Leftover Receiver: ${leftoverReceiver}`);

      // Create connection for creating the duplicate config using config.rpcUrl
      const targetConnection = new Connection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);
      console.log(`- Target RPC URL: ${config.rpcUrl}`);

      // Generated new config keypair
      const dbcInstance = new DynamicBondingCurveClient(targetConnection, 'confirmed');
      const configKeypair = Keypair.generate();
      console.log(`\n> Generated new config keypair: ${configKeypair.publicKey.toString()}`);

      const migrationSqrtPrice = new BN(poolConfig.migrationSqrtPrice, 16);

      // Extract non-zero curve points up to migration price
      const curveNodes = poolConfig.curve.filter((node: any) => {
        const price = new BN(node.sqrtPrice, 16);
        return (
          (price.gt(new BN(0)) || new BN(node.liquidity, 16).gt(new BN(0))) &&
          price.lte(migrationSqrtPrice)
        );
      });

      // Sqrt Prices including start price
      const sqrtPrices = [
        new BN(poolConfig.sqrtStartPrice, 16),
        ...curveNodes.map((node: any) => new BN(node.sqrtPrice, 16)),
      ];

      // Ensure last price is exactly migration price if not already
      if (!sqrtPrices[sqrtPrices.length - 1].eq(migrationSqrtPrice)) {
        sqrtPrices.push(migrationSqrtPrice);
      }

      // Liquidity weights (using liquidity values as weights)
      // Normalize to avoid huge numbers that might cause issues in SDK
      const rawWeights = curveNodes.map(
        (node: any) => new Decimal(new BN(node.liquidity, 16).toString())
      );
      // If we added a migration point, we might need an extra weight.
      // But usually curveNodes already includes it or we added it above.
      // If we added a point, let's give it a small weight or copy the previous one.
      if (rawWeights.length < sqrtPrices.length - 1) {
        rawWeights.push(rawWeights[rawWeights.length - 1] || new Decimal(1));
      }

      const maxWeight = rawWeights.reduce(
        (max: Decimal, w: Decimal) => (w.gt(max) ? w : max),
        new Decimal(0)
      );
      const liquidityWeights = rawWeights.map((w: Decimal) =>
        maxWeight.gt(0) ? w.div(maxWeight).mul(1000000).toNumber() : 1
      );

      const tokenBaseDecimal = new BN(poolConfig.tokenDecimal, 16).toNumber();
      const tokenQuoteDecimal = 9;

      // Reconstruct buildCurve params to get valid ConfigParameters
      const feeNumerator = new BN(poolConfig.poolFees.baseFee.cliffFeeNumerator, 16);
      const startingFeeBps = feeNumerator.div(new BN(100000)).toNumber();

      const buildCurveParams: any = {
        token: {
          tokenType: new BN(poolConfig.tokenType, 16).toNumber(),
          tokenBaseDecimal: tokenBaseDecimal,
          tokenQuoteDecimal: tokenQuoteDecimal,
          tokenUpdateAuthority: new BN(poolConfig.tokenUpdateAuthority, 16).toNumber(),
          totalTokenSupply: new Decimal(new BN(poolConfig.preMigrationTokenSupply, 16).toString())
            .div(10 ** tokenBaseDecimal)
            .toNumber(),
          leftover: new Decimal(
            new BN(poolConfig.leftover || poolConfig.migrationBaseThreshold || 0, 16).toString()
          )
            .div(10 ** tokenBaseDecimal)
            .toNumber(),
        },
        fee: {
          baseFeeParams:
            new BN(poolConfig.poolFees.baseFee.baseFeeMode, 16).toNumber() === 2
              ? {
                  baseFeeMode: 2,
                  rateLimiterParam: {
                    baseFeeBps: startingFeeBps,
                    feeIncrementBps: new BN(poolConfig.poolFees.baseFee.firstFactor, 16).toNumber(),
                    maxLimiterDuration: new BN(
                      poolConfig.poolFees.baseFee.secondFactor,
                      16
                    ).toNumber(),
                    referenceAmount: new Decimal(
                      new BN(poolConfig.poolFees.baseFee.thirdFactor, 16).toString()
                    )
                      .div(10 ** tokenBaseDecimal)
                      .toNumber(),
                  },
                }
              : {
                  baseFeeMode: new BN(poolConfig.poolFees.baseFee.baseFeeMode, 16).toNumber(),
                  feeSchedulerParam: {
                    startingFeeBps: startingFeeBps,
                    endingFeeBps: startingFeeBps, // Simplified guess, ideally we'd look at the curve to find the last price's fee if dynamic
                    numberOfPeriod: new BN(poolConfig.poolFees.baseFee.firstFactor, 16).toNumber(),
                    totalDuration: new BN(poolConfig.poolFees.baseFee.secondFactor, 16).toNumber(),
                  },
                },
          dynamicFeeEnabled:
            !!poolConfig.poolFees.dynamicFee && !!poolConfig.poolFees.dynamicFee.initialized,
          collectFeeMode: new BN(poolConfig.collectFeeMode, 16).toNumber(),
          creatorTradingFeePercentage: new BN(
            poolConfig.creatorTradingFeePercentage,
            16
          ).toNumber(),
          poolCreationFee: new Decimal(new BN(poolConfig.poolCreationFee, 16).toString())
            .div(10 ** 9)
            .toNumber(),
          enableFirstSwapWithMinFee: !!poolConfig.enableFirstSwapWithMinFee,
        },
        migration: {
          migrationOption: new BN(poolConfig.migrationOption, 16).toNumber(),
          migrationFeeOption: new BN(poolConfig.migrationFeeOption, 16).toNumber(),
          migrationFee: {
            feePercentage: new BN(poolConfig.migrationFeePercentage, 16).toNumber(),
            creatorFeePercentage: new BN(poolConfig.creatorMigrationFeePercentage, 16).toNumber(),
          },
          migratedPoolFee: {
            collectFeeMode: new BN(poolConfig.migratedCollectFeeMode, 16).toNumber(),
            dynamicFee: new BN(poolConfig.migratedDynamicFee, 16).toNumber(),
            poolFeeBps: new BN(poolConfig.migratedPoolFeeBps, 16).toNumber(),
            baseFeeMode: new BN(poolConfig.migratedPoolBaseFeeMode, 16).toNumber(),
            marketCapFeeSchedulerParams:
              (new BN(poolConfig.migratedPoolBaseFeeMode, 16).toNumber() === 3 ||
                new BN(poolConfig.migratedPoolBaseFeeMode, 16).toNumber() === 4) &&
              poolConfig.migratedPoolMarketCapFeeSchedulerParams
                ? {
                    endingBaseFeeBps:
                      poolConfig.migratedPoolMarketCapFeeSchedulerParams.reductionFactor &&
                      poolConfig.migratedPoolMarketCapFeeSchedulerParams.reductionFactor !== '00'
                        ? new BN(
                            poolConfig.migratedPoolMarketCapFeeSchedulerParams.reductionFactor,
                            16
                          ).toNumber()
                        : 0,
                    numberOfPeriod: new BN(
                      poolConfig.migratedPoolMarketCapFeeSchedulerParams.numberOfPeriod || 0,
                      16
                    ).toNumber(),
                    sqrtPriceStepBps: new BN(
                      poolConfig.migratedPoolMarketCapFeeSchedulerParams.sqrtPriceStepBps || 0,
                      16
                    ).toNumber(),
                    schedulerExpirationDuration: new BN(
                      poolConfig.migratedPoolMarketCapFeeSchedulerParams
                        .schedulerExpirationDuration || 0,
                      16
                    ).toNumber(),
                  }
                : undefined,
          },
        },
        liquidityDistribution: {
          partnerLiquidityPercentage: new BN(poolConfig.partnerLiquidityPercentage, 16).toNumber(),
          creatorLiquidityPercentage: new BN(poolConfig.creatorLiquidityPercentage, 16).toNumber(),
          partnerPermanentLockedLiquidityPercentage: new BN(
            poolConfig.partnerPermanentLockedLiquidityPercentage,
            16
          ).toNumber(),
          creatorPermanentLockedLiquidityPercentage: new BN(
            poolConfig.creatorPermanentLockedLiquidityPercentage,
            16
          ).toNumber(),
          partnerLiquidityVestingInfoParams: {
            vestingPercentage: new BN(
              poolConfig.partnerLiquidityVestingInfo.vestingPercentage,
              16
            ).toNumber(),
            bpsPerPeriod: new BN(
              poolConfig.partnerLiquidityVestingInfo.bpsPerPeriod,
              16
            ).toNumber(),
            numberOfPeriods: new BN(
              poolConfig.partnerLiquidityVestingInfo.numberOfPeriods,
              16
            ).toNumber(),
            cliffDurationFromMigrationTime: new BN(
              poolConfig.partnerLiquidityVestingInfo.cliffDurationFromMigrationTime,
              16
            ).toNumber(),
            frequency: new BN(poolConfig.partnerLiquidityVestingInfo.frequency || 0, 16).toNumber(),
            totalDuration: new BN(
              poolConfig.partnerLiquidityVestingInfo.totalDuration || 0,
              16
            ).toNumber(),
          },
          creatorLiquidityVestingInfoParams: {
            vestingPercentage: new BN(
              poolConfig.creatorLiquidityVestingInfo.vestingPercentage,
              16
            ).toNumber(),
            bpsPerPeriod: new BN(
              poolConfig.creatorLiquidityVestingInfo.bpsPerPeriod,
              16
            ).toNumber(),
            numberOfPeriods: new BN(
              poolConfig.creatorLiquidityVestingInfo.numberOfPeriods,
              16
            ).toNumber(),
            cliffDurationFromMigrationTime: new BN(
              poolConfig.creatorLiquidityVestingInfo.cliffDurationFromMigrationTime,
              16
            ).toNumber(),
            frequency: new BN(poolConfig.creatorLiquidityVestingInfo.frequency || 0, 16).toNumber(),
            totalDuration: new BN(
              poolConfig.creatorLiquidityVestingInfo.totalDuration || 0,
              16
            ).toNumber(),
          },
        },
        lockedVesting: {
          totalLockedVestingAmount: new Decimal(
            new BN(poolConfig.lockedVestingConfig.numberOfPeriod, 16)
              .mul(new BN(poolConfig.lockedVestingConfig.amountPerPeriod, 16))
              .add(new BN(poolConfig.lockedVestingConfig.cliffUnlockAmount, 16))
              .toString()
          )
            .div(10 ** tokenBaseDecimal)
            .toNumber(),
          numberOfVestingPeriod: new BN(
            poolConfig.lockedVestingConfig.numberOfPeriod,
            16
          ).toNumber(),
          cliffUnlockAmount: new Decimal(
            new BN(poolConfig.lockedVestingConfig.cliffUnlockAmount, 16).toString()
          )
            .div(10 ** tokenBaseDecimal)
            .toNumber(),
          totalVestingDuration: new BN(poolConfig.lockedVestingConfig.numberOfPeriod, 16)
            .mul(new BN(poolConfig.lockedVestingConfig.frequency, 16))
            .toNumber(),
          cliffDurationFromMigrationTime: new BN(
            poolConfig.lockedVestingConfig.cliffDurationFromMigrationTime,
            16
          ).toNumber(),
        },
        activationType: poolConfig.activationType,
        sqrtPrices,
        liquidityWeights,
      };

      console.log(
        `\n> buildCurveParams:`,
        JSON.stringify(
          buildCurveParams,
          (key, value) => (typeof value === 'bigint' ? value.toString() : value),
          2
        )
      );

      const curveConfig = buildCurveWithCustomSqrtPrices(buildCurveParams);

      const createConfigTx = await dbcInstance.partner.createConfig({
        config: configKeypair.publicKey,
        quoteMint: new PublicKey(poolConfig.quoteMint),
        feeClaimer: new PublicKey(feeClaimer),
        leftoverReceiver: new PublicKey(leftoverReceiver),
        payer: wallet.publicKey,
        poolFees: curveConfig.poolFees,
        collectFeeMode: curveConfig.collectFeeMode,
        migrationOption: curveConfig.migrationOption,
        activationType: curveConfig.activationType,
        tokenType: curveConfig.tokenType,
        tokenDecimal: curveConfig.tokenDecimal,
        partnerLiquidityPercentage: curveConfig.partnerLiquidityPercentage,
        partnerPermanentLockedLiquidityPercentage:
          curveConfig.partnerPermanentLockedLiquidityPercentage,
        creatorLiquidityPercentage: curveConfig.creatorLiquidityPercentage,
        creatorPermanentLockedLiquidityPercentage:
          curveConfig.creatorPermanentLockedLiquidityPercentage,
        migrationQuoteThreshold: curveConfig.migrationQuoteThreshold,
        sqrtStartPrice: curveConfig.sqrtStartPrice,
        lockedVesting: curveConfig.lockedVesting,
        migrationFeeOption: curveConfig.migrationFeeOption,
        tokenSupply: curveConfig.tokenSupply,
        creatorTradingFeePercentage: curveConfig.creatorTradingFeePercentage,
        tokenUpdateAuthority: curveConfig.tokenUpdateAuthority,
        migrationFee: curveConfig.migrationFee,
        migratedPoolFee: curveConfig.migratedPoolFee,
        poolCreationFee: curveConfig.poolCreationFee,
        partnerLiquidityVestingInfo: curveConfig.partnerLiquidityVestingInfo,
        creatorLiquidityVestingInfo: curveConfig.creatorLiquidityVestingInfo,
        migratedPoolBaseFeeMode: curveConfig.migratedPoolBaseFeeMode,
        migratedPoolMarketCapFeeSchedulerParams:
          curveConfig.migratedPoolMarketCapFeeSchedulerParams,
        enableFirstSwapWithMinFee: curveConfig.enableFirstSwapWithMinFee,
        padding: [],
        curve: curveConfig.curve,
      });

      modifyComputeUnitPriceIx(createConfigTx as any, config.computeUnitPriceMicroLamports ?? 0);

      if (config.dryRun) {
        console.log(`\n> Simulating duplicate config tx...`);
        await runSimulateTransaction(
          targetConnection,
          [wallet.payer, configKeypair],
          wallet.publicKey,
          [createConfigTx]
        );
        console.log(`> Duplicate config simulation successful`);
      } else {
        console.log(`\n>> Sending duplicate config transaction...`);
        const txHash = await sendAndConfirmTransaction(
          targetConnection,
          createConfigTx,
          [wallet.payer, configKeypair],
          {
            commitment: targetConnection.commitment,
            maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
          }
        );

        console.log(`>>> Config duplicated successfully with tx hash: ${txHash}`);
        console.log(`>>> New Config public key: ${configKeypair.publicKey.toString()}`);
      }
    }
  } catch (error) {
    console.error('\n❌ Error duplicating DBC pool config:');
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(errorMessage);
    process.exit(1);
  }
}

main();
