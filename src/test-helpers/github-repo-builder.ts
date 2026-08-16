import { GitHubRepository } from "../models/github-repository";
import { Owner } from "../models/owner";
/**
 * Inlined from the deleted GitHub API client, which this fixture needed for one constant. The
 * endpoint is a fixture detail here — `Owner` stores whatever string it is given — so the fixture
 * owns it rather than resurrecting a service layer to supply it.
 */
const dotComApiEndpoint = "https://api.github.com";

let id_counter = 0;

/**
 * Most of these fields are passed on to the
 * GitHubRepository constructor directly.
 *
 * Notable exception: `endpoint`
 */
interface IGitHubRepoFixtureOptions {
  owner: string;
  name: string;
  parent?: GitHubRepository;
  /** defaults to 'main' */
  defaultBranch?: string;
  isPrivate?: boolean;

  /**
   * Defaults to github.com if omitted.
   * We make an attempt at constructing a meaningful non-github.com
   * clone url and html url from this, even if its ''.
   */
  endpoint?: string;
  login?: string;
}

/**
 * Makes a fairly standard `GitHubRepository` for use in tests.
 * Ensures a unique `dbID` for each, during a test run.
 *
 * @param options
 * @returns a new GitHubRepository model
 */
export function gitHubRepoFixture({
  owner,
  name,
  parent,
  endpoint,
  isPrivate,
  login,
}: IGitHubRepoFixtureOptions): GitHubRepository {
  const htmlUrl = `${endpoint !== undefined ? endpoint : "https://github.com"}/${owner}/${name}`;
  return new GitHubRepository(
    name,
    "github",
    new Owner(owner, endpoint !== undefined ? endpoint : dotComApiEndpoint, id_counter++),
    login,
    id_counter++,
    isPrivate !== undefined ? isPrivate : null,
    htmlUrl,
    `${htmlUrl}.git`,
    null,
    null,
    null,
    parent,
  );
}
