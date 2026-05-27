import { handleNodeRequest } from "../src/server";
import type { IncomingMessage, ServerResponse } from "http";

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await handleNodeRequest(req, res);
}
