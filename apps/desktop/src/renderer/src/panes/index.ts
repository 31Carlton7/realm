/** Registers concrete pane implementations. Import once from App. */
import { registerPane } from "./registry";
import { TerminalPane } from "./TerminalPane";
registerPane("terminal", TerminalPane);
import { SessionPane } from "./session/SessionPane";
registerPane("session", SessionPane);
import { DiffPane } from "./diff/DiffPane";
registerPane("diff", DiffPane);
import { BrowserPane } from "./browser/BrowserPane";
registerPane("browser", BrowserPane);
import { SpacePage } from "./space/SpacePage";
registerPane("space-page", SpacePage);
