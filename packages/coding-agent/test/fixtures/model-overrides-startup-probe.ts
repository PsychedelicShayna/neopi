import { Settings } from "../../src/config/settings";
import { ModelsConfigFile } from "../../src/config/models-config";
import { ModelConfigEditor } from "../../src/config/model-config-editor";
import * as path from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("Isolated test directory is required");
await Settings.init({ cwd: dir, agentDir: dir, inMemory: true });
const entries = new ModelConfigEditor(ModelsConfigFile.relocate(path.join(dir, "models.toml"))).list();
if (entries.length !== 0) throw new Error("Absent model configuration must be empty");
