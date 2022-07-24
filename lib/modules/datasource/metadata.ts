import URL from 'url';
import is from '@sindresorhus/is';
import parse from 'github-url-from-git';
import { DateTime } from 'luxon';
import * as hostRules from '../../util/host-rules';
import { regEx } from '../../util/regex';
import { parseUrl, urlPathDepth, validateUrl } from '../../util/url';
import { detectPlatform } from '../platform/util';
import { manualChangelogUrls, manualSourceUrls } from './metadata-manual';
import type { ReleaseResult } from './types';

const githubPages = regEx('^https://([^.]+).github.com/([^/]+)$');
const gitPrefix = regEx('^git:/?/?');

export function massageUrl(sourceUrl: string): string {
  const parsedUrl = URL.parse(sourceUrl);
  if (!parsedUrl?.hostname) {
    return '';
  }
  if (parsedUrl.hostname.includes('gitlab')) {
    return massageGitlabUrl(sourceUrl);
  }
  return massageGithubUrl(sourceUrl);
}

export function massageGithubUrl(url: string): string {
  let massagedUrl = url;

  if (url.startsWith('git@')) {
    massagedUrl = url.replace(':', '/').replace('git@', 'https://');
  }

  return massagedUrl
    .replace('http:', 'https:')
    .replace('http+git:', 'https:')
    .replace('https+git:', 'https:')
    .replace('ssh://git@', 'https://')
    .replace(gitPrefix, 'https://')
    .replace(githubPages, 'https://github.com/$1/$2')
    .replace('www.github.com', 'github.com')
    .split('/')
    .slice(0, 5)
    .join('/');
}

function massageGitlabUrl(url: string): string {
  return url
    .replace('http:', 'https:')
    .replace(gitPrefix, 'https://')
    .replace(regEx(/\/tree\/.*$/i), '')
    .replace(regEx(/\/$/i), '')
    .replace('.git', '');
}

export function normalizeDate(input: any): string | null {
  if (
    typeof input === 'number' &&
    !Number.isNaN(input) &&
    input > 0 &&
    input <= Date.now() + 24 * 60 * 60 * 1000
  ) {
    return new Date(input).toISOString();
  }

  if (typeof input === 'string') {
    // `Date.parse()` is more permissive, but it assumes local time zone
    // for inputs like `2021-01-01`.
    //
    // Here we try to parse with default UTC with fallback to `Date.parse()`.
    //
    // It allows us not to care about machine timezones so much, though
    // some misinterpretation is still possible, but only if both:
    //
    //   1. Renovate machine is configured for non-UTC zone
    //   2. Format of `input` is very exotic
    //      (from `DateTime.fromISO()` perspective)
    //
    const luxonDate = DateTime.fromISO(input, { zone: 'UTC' });
    if (luxonDate.isValid) {
      return luxonDate.toISO();
    }

    return normalizeDate(Date.parse(input));
  }

  if (input instanceof Date) {
    return input.toISOString();
  }

  return null;
}

function massageTimestamps(dep: ReleaseResult): void {
  for (const release of dep.releases || []) {
    let { releaseTimestamp } = release;
    delete release.releaseTimestamp;
    releaseTimestamp = normalizeDate(releaseTimestamp);
    if (releaseTimestamp) {
      release.releaseTimestamp = releaseTimestamp;
    }
  }
}

export function addMetaData(
  dep: ReleaseResult,
  datasource: string,
  packageName: string
): void {
  massageTimestamps(dep);

  const packageNameLowercase = packageName.toLowerCase();
  const manualChangelogUrl =
    manualChangelogUrls[datasource]?.[packageNameLowercase];
  if (manualChangelogUrl) {
    dep.changelogUrl = manualChangelogUrl;
  }

  const manualSourceUrl = manualSourceUrls[datasource]?.[packageNameLowercase];
  if (manualSourceUrl) {
    dep.sourceUrl = manualSourceUrl;
  }

  if (
    dep.changelogUrl &&
    detectPlatform(dep.changelogUrl) === 'github' &&
    !dep.sourceUrl
  ) {
    dep.sourceUrl = dep.changelogUrl;
  }

  if (dep.homepage && !dep.sourceUrl) {
    setSourceUrlToHomepage(dep);
  }
  const extraBaseUrls = [];
  // istanbul ignore next
  hostRules.hosts({ hostType: 'github' }).forEach((host) => {
    extraBaseUrls.push(host, `gist.${host}`);
  });
  extraBaseUrls.push('gitlab.com');
  if (dep.sourceUrl) {
    const massagedUrl = massageUrl(dep.sourceUrl);
    if (is.emptyString(massagedUrl)) {
      delete dep.sourceUrl;
    } else {
      // try massaging it
      dep.sourceUrl =
        parse(massagedUrl, {
          extraBaseUrls,
        }) || dep.sourceUrl;
    }

    if (dep.homepage && dep.homepage === dep.sourceUrl) {
      delete dep.homepage;
    }
  }
  // Clean up any empty urls
  const urlKeys: (keyof ReleaseResult)[] = [
    'homepage',
    'sourceUrl',
    'changelogUrl',
    'dependencyUrl',
  ];
  for (const urlKey of urlKeys) {
    const urlVal = dep[urlKey];
    if (is.string(urlVal) && validateUrl(urlVal.trim())) {
      dep[urlKey] = urlVal.trim() as never;
    } else {
      delete dep[urlKey];
    }
  }
}

export function setSourceUrlToHomepage(dep: ReleaseResult): void {
  if (!dep?.homepage) {
    return;
  }
  const platform = detectPlatform(dep.homepage);
  if (platform !== 'github' && platform !== 'gitlab') {
    return;
  }
  dep.sourceUrl = dep.homepage;
  if (shouldDeleteHomepage(dep.sourceUrl, dep.homepage)) {
    // remove homepage if its not a link to a path in a github/gitlab repo.
    delete dep.homepage;
  }
}

export function shouldDeleteHomepage(
  sourceUrl: string,
  homepage: string
): boolean {
  const massagedSourceUrl = massageUrl(sourceUrl);
  if (massagedSourceUrl === homepage) {
    return true;
  }
  const sourceUrlParsed = parseUrl(massagedSourceUrl);
  if (is.nullOrUndefined(sourceUrlParsed)) {
    return false;
  }
  const homepageParsed = parseUrl(homepage);
  if (is.nullOrUndefined(homepageParsed)) {
    return false;
  }
  // if urlDepth is less than or equal to 2 then url is not
  // a link to a path in the repo.
  // this case handles these kinds of links:
  //   github.com/org
  //   github.com/org/
  //   gitub.com/org/repo
  //   github.com/org/repo/
  if (urlPathDepth(homepage) <= 2) {
    return true;
  }
  let hPath = homepageParsed.pathname;
  if (hPath.charAt(hPath.length - 1) === '/') {
    hPath = hPath.substring(0, hPath.length - 1); // remove last slash
  }
  return hPath === sourceUrlParsed.pathname;
}
