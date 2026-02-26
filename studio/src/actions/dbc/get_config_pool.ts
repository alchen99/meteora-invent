import { Connection, PublicKey } from '@solana/web3.js';
import { getDbcConfig, parseCliArguments } from '../../helpers';
import {
  DEVNET_RPC_URL,
  MAINNET_RPC_URL,
  LOCALNET_RPC_URL,
  DEFAULT_COMMITMENT_LEVEL,
} from '../../utils/constants';
import { getDbcConfigByAddress, getDbcPoolConfigByPoolAddress } from '../../lib/dbc';

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
  console.log(`- Using RPC URL ${rpcUrl}`);
  if (poolAddress) {
    console.log(`- Using pool address ${poolAddress}`);
  }
  if (configPublicKey) {
    console.log(`- Using config public key ${configPublicKey}`);
  }

  const connection = new Connection(rpcUrl, DEFAULT_COMMITMENT_LEVEL);

  try {
    let result;
    if (configPublicKey) {
      result = await getDbcConfigByAddress(connection, new PublicKey(configPublicKey));
    } else if (poolAddress) {
      result = await getDbcPoolConfigByPoolAddress(connection, new PublicKey(poolAddress));
    }

    if (result) {
      const { configAddress, poolConfig } = result;
      console.log(`\n> DBC Pool Config Address: ${configAddress.toString()}`);
      console.log('\n> DBC Pool Config:');
      console.log(JSON.stringify(poolConfig, null, 2));
    }
  } catch (error) {
    console.error('\n❌ Error fetching DBC pool config:');
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(errorMessage);
    process.exit(1);
  }
}

main();
