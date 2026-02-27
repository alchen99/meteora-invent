import { Connection, PublicKey } from '@solana/web3.js';
import { getDbcConfig, parseCliArguments } from '../../helpers';
import {
  DEVNET_RPC_URL,
  MAINNET_RPC_URL,
  LOCALNET_RPC_URL,
  DEFAULT_COMMITMENT_LEVEL,
} from '../../utils/constants';
import { getDbcPoolConfig } from '../../lib/dbc';

async function main() {
  const config = await getDbcConfig();

  const { baseMint, network } = parseCliArguments();
  if (!baseMint) {
    throw new Error('Please provide --baseMint flag to do this action');
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
  console.log(`- Using base token mint ${baseMint.toString()}`);

  const connection = new Connection(rpcUrl, DEFAULT_COMMITMENT_LEVEL);

  try {
    const { configAddress, poolConfig } = await getDbcPoolConfig(
      connection,
      new PublicKey(baseMint)
    );
    console.log(`\n> DBC Pool Config Address: ${configAddress.toString()}`);
    console.log('\n> DBC Pool Config:');
    console.log(JSON.stringify(poolConfig, null, 2));
  } catch (error) {
    console.error('\n❌ Error fetching DBC pool config:');
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(errorMessage);
    process.exit(1);
  }
}

main();
