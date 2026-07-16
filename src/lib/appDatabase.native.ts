import * as SQLite from 'expo-sqlite';

import type { AppDatabase } from './appDatabase';

export async function openAppDatabase(): Promise<AppDatabase> {
  return SQLite.openDatabaseAsync('mama-sales.db') as unknown as AppDatabase;
}
