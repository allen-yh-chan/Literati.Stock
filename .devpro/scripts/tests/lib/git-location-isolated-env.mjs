// Importing this module first removes, from the test process, the git variables that choose which repository git
// reads (GIT_DIR and the others in GIT_REPOSITORY_LOCATING_ENV_VARS). Every fixture `git init`, `remote add` or
// `config`, and every hook run that inherits process.env, then acts on the fixture's own checkout even when the test
// runner exports one (PR #3703 r7 W3-F2, W4-F3, W5-F1, W6-F1). A test that needs one sets it itself and restores it.
import { GIT_REPOSITORY_LOCATING_ENV_VARS } from "../../hooks/lib/git-utils.mjs";

for (const name of GIT_REPOSITORY_LOCATING_ENV_VARS) delete process.env[name];
