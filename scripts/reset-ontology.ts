/**
 * 把运行时本体（ontology.json，包含会话中建设的概念）
 * 重置为仓库内的种子本体（ontology.seed.json）。
 *
 * 用法：npm run ontology:reset
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { OntologyStore } from "../src/mcp/ontology.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const store = new OntologyStore(
  path.join(projectRoot, "ontology.json"),
  path.join(projectRoot, "ontology.seed.json"),
);

const graph = await store.reset();
console.log(
  `已重置本体：${graph.concepts.length} 个概念、${graph.instances.length} 个实例（种子状态）`,
);
