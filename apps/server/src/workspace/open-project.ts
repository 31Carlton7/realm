import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { Environment, Project, Space } from "@realm/contracts";
import type { EnvironmentsStore } from "../store/environments";
import type { ProfilesStore } from "../store/profiles";
import type { ProjectsStore } from "../store/projects";
import type { SpacesStore } from "../store/spaces";
import { NotFoundError, RpcError } from "../store/rows";

export type OpenProjectDeps = { profiles: ProfilesStore; spaces: SpacesStore; projects: ProjectsStore; environments: EnvironmentsStore };

/**
 * `projects.open`: a folder on disk as a project with a checkout environment, found or made.
 *
 * Idempotent, because the caller is a script that cannot know whether it ran before: the second call
 * for the same folder answers with the first call's space, project and environment. Synchronous, so
 * two calls for one new folder cannot both decide it is new — the server runs one handler at a time.
 *
 * The path is resolved through symlinks first. `/tmp/repo` and `/private/tmp/repo` are one checkout
 * on a Mac, and two projects for it would be two environments whose worktrees collide in one `.git`.
 */
export function openProject(d: OpenProjectDeps, input: { path: string; spaceId?: string }): { space: Space; project: Project; environment: Environment; createdSpace: boolean } {
  if (!isAbsolute(input.path)) throw new RpcError("PATH_NOT_ABSOLUTE", `${input.path} is not an absolute path`);
  let root: string;
  try {
    root = realpathSync(input.path);
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new RpcError("PATH_NOT_DIRECTORY", `${input.path} is not a folder on this computer`);
  }
  if (input.spaceId && !d.spaces.get(input.spaceId)) throw new NotFoundError("space", input.spaceId);

  let createdSpace = false;
  let project = d.projects.findByRoot(root, input.spaceId);
  if (!project) {
    let spaceId = input.spaceId;
    if (!spaceId) {
      const profile = d.profiles.list()[0];
      if (!profile) throw new RpcError("NO_PROFILE", "this Realm home has no profile to put a space in");
      spaceId = d.spaces.create({ profileId: profile.id, name: basename(root) || root, icon: "folder" }).id;
      createdSpace = true;
    }
    project = d.projects.create({ spaceId, name: basename(root) || root, rootPath: root, defaultBranch: "main" });
  }
  const environment = d.environments.ensureAt(project.spaceId, root, "checkout");
  return { space: d.spaces.get(project.spaceId)!, project, environment, createdSpace };
}
