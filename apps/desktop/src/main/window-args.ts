/** The command line an app window's renderer is started with, which the preload reads back. */
export function windowArguments(o: { port: number; home: string; token: string; profileId: string | null; spaceId: string | null; land: string | null }): string[] {
  return [`--realm-port=${o.port}`, `--realm-home=${o.home}`, `--realm-token=${o.token}`,
    ...(o.profileId !== null ? [`--realm-profile=${o.profileId}`] : []),
    ...(o.spaceId !== null ? [`--realm-space=${o.spaceId}`] : []),
    ...(o.land !== null ? [`--realm-land=${o.land}`] : [])];
}
