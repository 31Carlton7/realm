# Third-party notices

Realm is MIT-licensed (see `LICENSE`). These parts of this repository come from other projects and stay
under their own licenses, whose texts sit beside them:

| What | Where | License |
|---|---|---|
| File-type icons from [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) | `apps/desktop/src/renderer/src/assets/file-icons/` | MIT (`LICENSE` there) |
| iOS device runner, derived from [Maestro](https://github.com/mobile-dev-inc/Maestro)'s XCTest runner | `resources/ios-device-runner/` | Apache-2.0 (`LICENSE` and `NOTICE` there) |
| [Inter](https://rsms.me/inter/) | `apps/desktop/src/renderer/src/assets/fonts/` | SIL Open Font License 1.1 (`OFL-Inter.txt`) |
| [JetBrains Mono](https://www.jetbrains.com/lp/mono/) | `apps/desktop/src/renderer/src/assets/fonts/`, `apps/ios/Realm/Fonts/` | SIL Open Font License 1.1 (`OFL.txt`, `JetBrainsMono-OFL.txt`) |

Not in this repository: the [Hugeicons Pro](https://hugeicons.com) icon packages, which official builds install
from Hugeicons' own registry under Realm's commercial license with them. They are not covered by Realm's MIT
license and must not be redistributed. Dependencies installed by `pnpm install` are under their own licenses.
