/**
 * A browser pane's page that did not load, and what Realm says about it.
 *
 * When a main-frame navigation fails, Chromium commits an error page in the failed URL's place — the
 * address stays in the bar, the entry stays in the history, and Reload retries it — but Electron draws
 * nothing on that page: it is an empty document, which is the white pane someone typing
 * `localhost:3000` with no server running was left looking at. So Realm draws the page itself (the
 * pane's own DOM, with the native view hidden over it) and tells an agent driving the pane the same
 * thing in words. Both read their copy from here, so the pane and the agent cannot disagree about why
 * a page is not there.
 *
 * Pure: an error and an address in, sentences out.
 */

/** The main frame's last navigation committed Chromium's error page instead of a document. `code` is
 *  the net error (negative), `name` its short name as Chromium reports it (`ERR_CONNECTION_REFUSED`),
 *  and `url` the address that was asked for — which the bar and the history keep. */
export type BrowserLoadError = { code: number; name: string; url: string };

/** A load the user or the page stopped. Never an error page: nothing failed. */
export const ERR_ABORTED = -3;

/**
 * The page's words. `mark` is which glyph it wears: the spiral reaching for a server, or the padlock
 * for a connection Realm will not trust. `note` is a second sentence only a certificate failure has —
 * why there is no way past the page. `tips` are the "Try:" list, empty when there is nothing useful to
 * suggest beyond Reload.
 */
export type BrowserLoadErrorPage = {
  mark: "reach" | "lock";
  title: string;
  reason: string;
  note: string | null;
  tips: string[];
};

const UNREACHABLE = "This site can't be reached";
const BROKEN = "This page isn't working";
const NETWORK_TIPS = ["Checking the connection", "Checking the proxy and the firewall"];
const SERVER_LOG_TIP = "Checking the server's output for an error";

/** This Mac, by any of the names a dev server is reached at. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/** The host a sentence names, and the port a tip names — the scheme's own when the address has none. */
function addressOf(url: string): { host: string; port: string; loopback: boolean } {
  try {
    const u = new URL(url);
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return { host: u.hostname, port, loopback: isLoopbackHost(u.hostname) };
  } catch {
    return { host: url, port: "", loopback: false };
  }
}

const isCertificate = (e: BrowserLoadError) =>
  /^ERR_CERT(?:IFICATE)?_/.test(e.name) || (e.code <= -200 && e.code >= -299)
  || e.name === "ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN" || e.name === "ERR_ECH_FALLBACK_CERTIFICATE_INVALID";
const isTls = (e: BrowserLoadError) => /^ERR_(?:SSL|BAD_SSL|ECH)_/.test(e.name);

/**
 * The certificate page. There is no way past it, and the page says so rather than hiding a button:
 * anything sent to a server Realm cannot verify may be read on the way, and a pane an agent can drive
 * is the last place to offer someone a casual "proceed anyway".
 */
function certificatePage(e: BrowserLoadError, host: string, loopback: boolean): BrowserLoadErrorPage {
  const page = (reason: string, tips: string[]): BrowserLoadErrorPage => ({
    mark: "lock", title: "Your connection isn't private", reason, tips,
    note: "Anything sent to it, such as a password, could be read on the way, so Realm won't open it.",
  });
  switch (e.name) {
    case "ERR_CERT_DATE_INVALID":
      return page(`The certificate ${host} sent has expired or isn't valid yet.`, ["Checking the date and time on this Mac"]);
    case "ERR_CERT_COMMON_NAME_INVALID":
      return page(`The certificate ${host} sent is for a different site.`, ["Checking the address"]);
    case "ERR_CERT_REVOKED":
      return page(`The certificate ${host} sent has been revoked.`, []);
    case "ERR_CERT_AUTHORITY_INVALID":
      return page(`The certificate ${host} sent isn't from an authority this Mac trusts.`, loopback
        ? ["Using http:// for a local server", "Trusting the server's certificate in Keychain Access"]
        : ["Checking the address", "Trying again from a network you trust"]);
    default:
      return page(`Realm can't verify the certificate ${host} sent.`, ["Checking the date and time on this Mac", "Checking the address"]);
  }
}

/** A secure connection that never got as far as a certificate. */
function tlsPage(e: BrowserLoadError, host: string, loopback: boolean): BrowserLoadErrorPage {
  const reason = e.name === "ERR_SSL_VERSION_OR_CIPHER_MISMATCH" ? `${host} uses a security protocol Realm doesn't support.`
    : e.name === "ERR_SSL_PROTOCOL_ERROR" ? `${host} didn't answer as a secure server.`
    : `${host} didn't set up a secure connection.`;
  return {
    mark: "lock", title: "This site can't provide a secure connection", reason, note: null,
    tips: loopback ? ["Using http:// if the server doesn't speak HTTPS"] : NETWORK_TIPS,
  };
}

export function describeLoadError(e: BrowserLoadError): BrowserLoadErrorPage {
  const { host, port, loopback } = addressOf(e.url);
  if (isCertificate(e)) return certificatePage(e, host, loopback);
  if (isTls(e)) return tlsPage(e, host, loopback);
  const page = (title: string, reason: string, tips: string[]): BrowserLoadErrorPage => ({ mark: "reach", title, reason, note: null, tips });
  switch (e.name) {
    case "ERR_CONNECTION_REFUSED":
      // On this Mac the reason is nearly always the same one: the dev server is not running, or it
      // came up on the next free port because something else had this one.
      return page(UNREACHABLE, `${host} refused to connect.`, loopback
        ? [`Checking that a server is running on port ${port}`, "Checking whether it started on another port"]
        : NETWORK_TIPS);
    case "ERR_NAME_NOT_RESOLVED": case "ERR_NAME_RESOLUTION_FAILED": case "ERR_DNS_SERVER_FAILED": case "ERR_DNS_TIMED_OUT": case "ERR_DNS_MALFORMED_RESPONSE":
      return page(UNREACHABLE, `${host}'s address couldn't be found.`, ["Checking the address for a typo", "Checking the connection", "Checking the proxy, firewall and DNS settings"]);
    case "ERR_CONNECTION_TIMED_OUT": case "ERR_TIMED_OUT":
      return page(UNREACHABLE, `${host} took too long to respond.`, loopback ? [`Checking that the server on port ${port} is responding`] : NETWORK_TIPS);
    case "ERR_INTERNET_DISCONNECTED":
      return page("No internet connection", "This Mac isn't connected to the internet.", ["Reconnecting to Wi-Fi", "Checking the network cable, modem and router"]);
    case "ERR_NETWORK_CHANGED":
      return page("Your connection was interrupted", "The network changed while the page was loading.", []);
    case "ERR_CONNECTION_RESET":
      return page(UNREACHABLE, `The connection to ${host} was reset.`, loopback ? [SERVER_LOG_TIP] : NETWORK_TIPS);
    case "ERR_CONNECTION_CLOSED":
      return page(UNREACHABLE, `${host} closed the connection unexpectedly.`, loopback ? [SERVER_LOG_TIP] : NETWORK_TIPS);
    case "ERR_CONNECTION_ABORTED": case "ERR_CONNECTION_FAILED":
      return page(UNREACHABLE, `The connection to ${host} failed.`, loopback ? [SERVER_LOG_TIP] : NETWORK_TIPS);
    case "ERR_ADDRESS_UNREACHABLE": case "ERR_ADDRESS_INVALID":
      return page(UNREACHABLE, `${host} is unreachable.`, NETWORK_TIPS);
    case "ERR_EMPTY_RESPONSE":
      // A plain-HTTP request to a port that speaks only TLS ends here too, which on a dev machine is
      // the likelier of the two.
      return page(BROKEN, `${host} didn't send any data.`, loopback ? [SERVER_LOG_TIP, "Using https:// if the server only speaks HTTPS"] : []);
    case "ERR_UNSAFE_PORT":
      return page(UNREACHABLE, `Port ${port} is reserved for another kind of service, so Realm won't open it.`, ["Serving the page on another port, such as 3000 or 8080"]);
    case "ERR_PROXY_CONNECTION_FAILED": case "ERR_TUNNEL_CONNECTION_FAILED": case "ERR_MANDATORY_PROXY_CONFIGURATION_FAILED": case "ERR_SOCKS_CONNECTION_FAILED":
      return page(UNREACHABLE, "Realm couldn't connect to the proxy server.", ["Checking the proxy settings in System Settings ▸ Network"]);
    case "ERR_TOO_MANY_REDIRECTS":
      return page(BROKEN, `${host} redirected too many times.`, ["Clearing browsing data, from the ⋯ menu"]);
    case "ERR_HTTP_RESPONSE_CODE_FAILURE":
      return page(BROKEN, `${host} answered with an error and no page.`, loopback ? [SERVER_LOG_TIP] : []);
    case "ERR_INVALID_RESPONSE": case "ERR_INVALID_HTTP_RESPONSE": case "ERR_RESPONSE_HEADERS_TRUNCATED": case "ERR_CONTENT_DECODING_FAILED":
    case "ERR_INCOMPLETE_CHUNKED_ENCODING": case "ERR_INVALID_CHUNKED_ENCODING": case "ERR_HTTP2_PROTOCOL_ERROR": case "ERR_QUIC_PROTOCOL_ERROR":
      return page(BROKEN, `${host} sent a response Realm couldn't read.`, loopback ? [SERVER_LOG_TIP] : []);
    case "ERR_BLOCKED_BY_RESPONSE":
      return page("This page was blocked", `${host} doesn't allow itself to be shown here.`, []);
    case "ERR_BLOCKED_BY_CLIENT": case "ERR_BLOCKED_BY_ADMINISTRATOR": case "ERR_NETWORK_ACCESS_DENIED":
      return page("This page was blocked", `Something on this Mac kept Realm from opening ${host}.`, ["Checking the firewall settings"]);
    default:
      return page(UNREACHABLE, `The page at ${host} didn't load.`, ["Checking the connection"]);
  }
}

/** The failure in one line, for an agent: what the page's title and reason say, and the code. */
export function loadErrorLine(e: BrowserLoadError): string {
  const page = describeLoadError(e);
  return `${page.title}: ${page.reason}${page.note ? ` ${page.note}` : ""} (${e.name})`;
}
