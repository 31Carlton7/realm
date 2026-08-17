import { useEffect, useState } from "react";
import { rpc } from "./rpc/client";
export function App() {
  const [info, setInfo] = useState<string>("connecting…");
  useEffect(() => { rpc().call("system.info", {}).then((i) => setInfo(`realm-server ${i.version} · ${i.realmHome}`)).catch((e) => setInfo(String(e))); }, []);
  return <div style={{ padding: 24, fontFamily: "system-ui" }}>{info}</div>;
}
