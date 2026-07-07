import { createContext } from './init';
import { appRouter } from './routers/_app';

export async function createServerCaller() {
  return appRouter.createCaller(await createContext());
}
