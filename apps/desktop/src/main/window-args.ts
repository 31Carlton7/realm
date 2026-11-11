/** The command line an app window's renderer is started with, which the preload reads back. `ps`
 *  shows it to every process, so the RPC token goes over IPC instead (`daemon:token`). */
export function windowArguments(o: { port: number; home: string; profileId: string | null; spaceId: string | null; land: string | null }): string[] {
  return [`--realm-port=${o.port}`, `--realm-home=${o.home}`,
    ...(o.profileId !== null ? [`--realm-profile=${o.profileId}`] : []),
    ...(o.spaceId !== null ? [`--realm-space=${o.spaceId}`] : []),
    ...(o.land !== null ? [`--realm-land=${o.land}`] : [])];
}
