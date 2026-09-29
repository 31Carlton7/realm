import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { connectToDevice, listDevices, muxPort, packet, parsePlist, plistXml } from "./usbmux";

/**
 * The usbmuxd client against a usbmuxd played by a Unix socket this test serves: the same framing,
 * the same plists, and a Connect that turns the socket into a pipe — an echo, here, standing in for
 * the runner on the phone's loopback.
 */

const PHONE = "00008150-0000AAAA1B2C3D4E";
const WIFI_ONLY = "00008150-0000FFFF00001111";

const LIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>DeviceList</key>
	<array>
		<dict>
			<key>DeviceID</key>
			<integer>41</integer>
			<key>MessageType</key>
			<string>Attached</string>
			<key>Properties</key>
			<dict>
				<key>ConnectionType</key>
				<string>Network</string>
				<key>DeviceID</key>
				<integer>41</integer>
				<key>SerialNumber</key>
				<string>${PHONE}</string>
			</dict>
		</dict>
		<dict>
			<key>DeviceID</key>
			<integer>40</integer>
			<key>MessageType</key>
			<string>Attached</string>
			<key>Properties</key>
			<dict>
				<key>ConnectionSpeed</key>
				<integer>480000000</integer>
				<key>ConnectionType</key>
				<string>USB</string>
				<key>DeviceID</key>
				<integer>40</integer>
				<key>SerialNumber</key>
				<string>${PHONE}</string>
				<key>USBSerialNumber</key>
				<string>${PHONE.replace("-", "")}</string>
				<key>Charging</key>
				<true/>
			</dict>
		</dict>
		<dict>
			<key>DeviceID</key>
			<integer>7</integer>
			<key>Properties</key>
			<dict>
				<key>ConnectionType</key>
				<string>Network</string>
				<key>DeviceID</key>
				<integer>7</integer>
				<key>SerialNumber</key>
				<string>${WIFI_ONLY}</string>
			</dict>
		</dict>
	</array>
</dict>
</plist>
`;

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

/** A usbmuxd. `result` is the Number a Connect answers with; `early` is what the phone says the
 *  moment the pipe opens, sent in the SAME write as the Result. */
async function usbmuxd(o: { result?: number; early?: string } = {}): Promise<{ path: string; asked: Record<string, unknown>[] }> {
  const path = join(tempDir("realm-mux-"), "usbmuxd");
  const asked: Record<string, unknown>[] = [];
  const server = createServer((sock) => {
    sockets.push(sock);
    let buf = Buffer.alloc(0);
    let piped = false;
    sock.on("data", (d) => {
      if (piped) { sock.write(d); return; } // the far end: an echo
      buf = Buffer.concat([buf, d]);
      if (buf.length < 16 || buf.length < buf.readUInt32LE(0)) return;
      const msg = parsePlist(buf.subarray(16, buf.readUInt32LE(0)).toString("utf8")) as Record<string, unknown>;
      asked.push(msg);
      if (msg.MessageType === "ListDevices") { sock.write(framed(LIST)); return; }
      if (msg.MessageType === "Connect") {
        const n = o.result ?? 0;
        sock.write(Buffer.concat([framed(plistXml({ MessageType: "Result", Number: n })), Buffer.from(n === 0 ? o.early ?? "" : "")]));
        piped = n === 0;
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, () => r()));
  return { path, asked };
}

const framed = (xml: string): Buffer => {
  const body = Buffer.from(xml, "utf8");
  const head = Buffer.alloc(16);
  head.writeUInt32LE(16 + body.length, 0); head.writeUInt32LE(1, 4); head.writeUInt32LE(8, 8); head.writeUInt32LE(1, 12);
  return Buffer.concat([head, body]);
};

describe("the plist dialect", () => {
  it("writes strings and integers that read back as themselves, escaped", () => {
    const xml = plistXml({ MessageType: "Connect", ProgName: "a<b&c", DeviceID: 40 });
    expect(parsePlist(xml)).toEqual({ MessageType: "Connect", ProgName: "a<b&c", DeviceID: 40 });
  });

  it("reads usbmuxd's device list: nested dicts, arrays, booleans, and the prolog it opens with", () => {
    const v = parsePlist(LIST) as { DeviceList: { Properties: Record<string, unknown> }[] };
    expect(v.DeviceList).toHaveLength(3);
    expect(v.DeviceList[1]!.Properties).toMatchObject({ ConnectionType: "USB", DeviceID: 40, SerialNumber: PHONE, Charging: true });
  });

  it("is an error, not a guess, for XML that is not a plist it knows", () => {
    expect(() => parsePlist("<html></html>")).toThrow(/no <plist>/);
    expect(() => parsePlist("<plist><date>2026</date></plist>")).toThrow(/not a value/);
  });

  it("frames a message with its length, version 1, the plist message type and the tag", () => {
    const p = packet({ MessageType: "ListDevices" }, 7);
    expect([p.readUInt32LE(0), p.readUInt32LE(4), p.readUInt32LE(8), p.readUInt32LE(12)]).toEqual([p.length, 1, 8, 7]);
  });

  it("puts the port in network byte order, as usbmuxd reads it", () => {
    expect(muxPort(7325)).toBe(0x9d1c);
    expect(muxPort(0x1234)).toBe(0x3412);
  });
});

describe("reaching a port on the phone", () => {
  it("lists every way each device is reachable", async () => {
    const mux = await usbmuxd();
    expect(await listDevices(mux.path)).toEqual([
      { deviceId: 41, udid: PHONE, connection: "Network" },
      { deviceId: 40, udid: PHONE, connection: "USB" },
      { deviceId: 7, udid: WIFI_ONLY, connection: "Network" },
    ]);
  });

  it("connects to the port on the cable when there is a cable, and the socket is then a pipe to it", async () => {
    const mux = await usbmuxd();
    const sock = await connectToDevice(PHONE, 7325, mux.path);
    sockets.push(sock);
    expect(mux.asked.at(-1)).toMatchObject({ MessageType: "Connect", DeviceID: 40, PortNumber: muxPort(7325) });
    const echoed = new Promise<string>((r) => sock.once("data", (d) => r(d.toString())));
    sock.write("GET /status HTTP/1.1\r\n\r\n");
    expect(await echoed).toBe("GET /status HTTP/1.1\r\n\r\n");
  });

  it("takes the network when that is the only way, and knows a UDID written without its hyphen", async () => {
    const mux = await usbmuxd();
    sockets.push(await connectToDevice(WIFI_ONLY.replace("-", ""), 80, mux.path));
    expect(mux.asked.at(-1)).toMatchObject({ MessageType: "Connect", DeviceID: 7 });
  });

  it("keeps what the phone sent in the same breath as usbmuxd's yes", async () => {
    const mux = await usbmuxd({ early: "HTTP/1.1 200 OK\r\n" });
    const sock = await connectToDevice(PHONE, 7325, mux.path);
    sockets.push(sock);
    const first = await new Promise<string>((r) => sock.once("data", (d) => r(d.toString())));
    expect(first).toBe("HTTP/1.1 200 OK\r\n");
  });

  it("says nothing is listening when usbmuxd refuses the port, and that the phone is not there when it is not", async () => {
    const mux = await usbmuxd({ result: 3 });
    await expect(connectToDevice(PHONE, 7325, mux.path)).rejects.toThrow("nothing on the phone is listening on that port");
    await expect(connectToDevice("00008150-0000000000000000", 7325, mux.path)).rejects.toThrow(/not on this Mac's cable or network/);
  });

  it("says where it looked when there is no usbmuxd at all", async () => {
    await expect(listDevices(join(tempDir("realm-mux-"), "missing"))).rejects.toThrow(/usbmuxd is not reachable at/);
  });
});
