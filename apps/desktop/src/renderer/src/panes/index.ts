/** Registers concrete pane implementations. Import once from App. */
import { registerPane } from "./registry";
import { TerminalPane } from "./TerminalPane";
registerPane("terminal", TerminalPane);
import { SessionPane } from "./session/SessionPane";
registerPane("session", SessionPane);
