import type { DatabaseOrTransaction, DatabaseTransaction } from '../db';

type TransactionCapableDatabase = DatabaseOrTransaction & {
  transaction<T>(callback: (tx: DatabaseTransaction) => Promise<T>): Promise<T>;
};

function canStartTransaction(
  dbOrTx: DatabaseOrTransaction,
): dbOrTx is TransactionCapableDatabase {
  return (
    typeof (dbOrTx as { transaction?: unknown }).transaction === 'function' &&
    typeof (dbOrTx as { rollback?: unknown }).rollback !== 'function'
  );
}

export async function runInTransactionIfAvailable<T>(
  dbOrTx: DatabaseOrTransaction,
  operation: (tx: DatabaseOrTransaction) => Promise<T>,
): Promise<T> {
  if (canStartTransaction(dbOrTx)) {
    return dbOrTx.transaction(operation);
  }

  return operation(dbOrTx);
}
