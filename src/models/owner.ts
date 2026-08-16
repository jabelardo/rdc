/**
 * What kind of GitHub account owns a repository.
 *
 * Defined here rather than imported from the API client: this is the only consumer, and the import
 * was the single thread tying `Repository` -> `GitHubRepository` -> `Owner` to the whole GitHub
 * service layer. It is erased at build time, so the bundle never showed it — but the source
 * reference kept a dead cluster looking alive.
 */
export type GitHubAccountType = "User" | "Organization";

/** The owner of a GitHubRepository. */
export class Owner {
  /**
   * @param id The database ID. This may be null if the object wasn't retrieved from the database.
   */
  public constructor(
    public readonly login: string,
    public readonly endpoint: string,
    public readonly id: number,
    public readonly type?: GitHubAccountType,
  ) {}
}
