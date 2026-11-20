#!/usr/bin/env node

/**
 * ArtisanPack UI docs migration helper.
 *
 * Applies the mechanical parts of DOCS_STANDARD.md to a package's docs/
 * folder. It does not write new content. Run docs-lint.mjs afterwards to see
 * what's left to do by hand.
 *
 * What it changes:
 *   - moves internal folders (plans/, audits/, design/, …) to .planning/
 *   - renames files and folders to kebab-case and the standard names
 *     (api/ → reference/, quick-start.md → getting-started.md, …)
 *   - merges duplicate section landing pages (usage/usage.md → usage.md),
 *     keeping the copy the docs site actually published
 *   - rewrites wiki-style and moved links to relative .md links
 *   - adds `redirect_from` front matter for every slug that changes
 *   - sets `title`, `menu_order` and a matching H1 on every page
 *   - demotes extra H1s, tags untagged code blocks, converts GitHub alerts
 *
 * Usage:
 *   node docs-migrate.mjs [docs-path] [--archetype=...]            # dry run: print the plan
 *   node docs-migrate.mjs [docs-path] [--archetype=...] --write    # apply it
 *
 * @since 1.0.0
 */

import { execFileSync } from 'node:child_process';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, posix, relative, resolve, sep } from 'node:path';

const INTERNAL_DIRECTORIES = [ 'plans', 'audits', 'design', 'benchmarks', 'decisions', 'notes', 'drafts' ];

/**
 * Folders the docs site importer never publishes (GitHubDocsService::IGNORED_DIRS).
 */
const IMPORTER_IGNORED_DIRECTORIES = [ 'plans', 'design', 'benchmarks', 'node_modules', 'vendor', '.git' ];

const IMAGE_EXTENSIONS = [ '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif' ];

const TOP_LEVEL_RENAMES = {
	api: 'reference',
	'api-reference': 'reference',
	'quick-start': 'getting-started',
	upgrade: 'upgrading',
	'upgrade-guide': 'upgrading',
};

const DIRECTORY_RENAMES = {
	api: 'reference',
	'api-reference': 'reference',
	upgrade: 'upgrading',
};

const STANDARD_SLOTS = {
	home: 0,
	'getting-started': 10,
	installation: 20,
	usage: 30,
	advanced: 80,
	reference: 85,
	upgrading: 90,
	faq: 95,
	troubleshooting: 99,
};

/**
 * Extra fixed slots for some archetypes.
 */
const ARCHETYPE_SLOTS = {
	package: {},
	'component-library': { components: 40 },
	'starter-kit': {},
	meta: {},
};

const STANDARD_TITLES = {
	home: 'Overview',
	'getting-started': 'Getting Started',
	faq: 'FAQ',
};

const ALERT_LABELS = {
	NOTE: 'Note',
	IMPORTANT: 'Note',
	TIP: 'Tip',
	WARNING: 'Warning',
	CAUTION: 'Warning',
};

const OPENING_FENCE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
const CLOSING_FENCE = /^\s{0,3}(`{3,}|~{3,})[ \t]*$/;
const BLOCKQUOTE_PREFIX = /^(?:\s{0,3}>[ ]?)*/;

const args         = process.argv.slice( 2 );
const write        = args.includes( '--write' );
const archetypeArg = args.find( ( arg ) => arg.startsWith( '--archetype=' ) );
const archetype    = archetypeArg ? archetypeArg.split( '=' )[1] : 'package';
const docsPath     = resolve( args.find( ( arg ) => ! arg.startsWith( '--' ) ) ?? 'docs' );
const repoRoot     = dirname( docsPath );
const slots        = { ...STANDARD_SLOTS, ...( ARCHETYPE_SLOTS[ archetype ] ?? {} ) };
const staging      = join( repoRoot, '.docs-migrate-staging' );
const backup       = join( repoRoot, '.docs-migrate-backup' );

const notes = [];

const repositoryUrl = ( () => {
	try {
		const remote = execFileSync( 'git', [ '-C', repoRoot, 'remote', 'get-url', 'origin' ], { encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'ignore' ] } ).trim();
		const match  = remote.match( /github\.com[:/](.+?)(?:\.git)?$/ );

		return match ? `https://github.com/${ match[1] }/blob/main` : null;
	} catch {
		return null;
	}
} )();

/**
 * Record something the script did or couldn't do.
 *
 * @param {string} message
 */
function note( message ) {
	notes.push( message );
}

/**
 * Stop with an error message.
 *
 * @param {string} message
 * @param {number} code
 */
function fail( message, code = 2 ) {
	console.error( message );
	process.exit( code );
}

/**
 * Convert any name to a kebab-case file name.
 *
 * @param {string} name
 * @returns {string}
 */
function kebab( name ) {
	return name
		.replace( /([a-z0-9])([A-Z])/g, '$1-$2' )
		.replace( /([A-Z]+)([A-Z][a-z])/g, '$1-$2' )
		.replace( /[\s_.]+/g, '-' )
		.replace( /-+/g, '-' )
		.replace( /^-|-$/g, '' )
		.toLowerCase();
}

/**
 * Convert a path segment to a slug segment exactly as the docs site does (GitHubDocsService::toKebab()).
 *
 * Unlike kebab(), this doesn't split camelCase: the site publishes UsageGuide.md as "usageguide".
 *
 * @param {string} segment
 * @returns {string}
 */
function siteKebab( segment ) {
	return segment.trim().replace( /[\s_]+/g, '-' ).replace( /-+/g, '-' ).replace( /^-+|-+$/g, '' ).toLowerCase();
}

/**
 * Normalize a slug or link target the way the docs site importer does.
 *
 * @param {string} value
 * @returns {string}
 */
function normalizeTarget( value ) {
	return value.trim().replace( /[\s_/]+/g, '-' ).replace( /-+/g, '-' ).replace( /^-|-$/g, '' ).toLowerCase();
}

/**
 * Decode a URL-encoded link target without throwing on malformed escapes like "100%".
 *
 * @param {string} value
 * @returns {string}
 */
function safeDecode( value ) {
	try {
		return decodeURI( value );
	} catch {
		return value;
	}
}

/**
 * Escape a string for use in a regular expression.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp( value ) {
	return value.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
}

/**
 * Read a YAML scalar: unwrap quotes, or drop a trailing comment from a plain value.
 *
 * @param {string} raw
 * @returns {string}
 */
function parseScalar( raw ) {
	const value = raw.trim();
	const quote = value[0];
	let output  = '';

	if ( "'" === quote ) {
		for ( let index = 1; index < value.length; index++ ) {
			if ( "'" === value[ index ] ) {
				if ( "'" !== value[ index + 1 ] ) {
					break;
				}

				index++;
			}

			output += value[ index ];
		}

		return output;
	}

	if ( '"' === quote ) {
		const escapes = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', 0: '\0' };

		for ( let index = 1; index < value.length; index++ ) {
			const character = value[ index ];

			if ( '\\' === character && index + 1 < value.length ) {
				output += escapes[ value[ ++index ] ] ?? value[ index ];

				continue;
			}

			if ( '"' === character ) {
				break;
			}

			output += character;
		}

		return output;
	}

	return value.replace( /\s+#.*$/, '' ).trim();
}

/**
 * Byte-per-character form of a string, so regular expressions match bytes the way PHP's fnmatch() does.
 *
 * @param {string} value
 * @returns {string}
 */
function toBytes( value ) {
	return Buffer.from( value, 'utf8' ).toString( 'latin1' );
}

/**
 * Compare two strings byte by byte, like PHP's sort() does for paths.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareBytes( a, b ) {
	return Buffer.compare( Buffer.from( a, 'utf8' ), Buffer.from( b, 'utf8' ) );
}

/**
 * GitHub's anchor for a heading.
 *
 * @param {string} text
 * @returns {string}
 */
function githubAnchor( text ) {
	return text
		.replace( /\[([^\]]*)\]\([^)]*\)/g, '$1' )
		.replace( /<[^>]+>/g, '' )
		.trim()
		.toLowerCase()
		.replace( /[^\p{L}\p{N}\p{M}\s_-]/gu, '' )
		.replace( /\s/g, '-' );
}

/**
 * Collapse a repeated trailing segment from wiki-era links ("Api-Api" → "api", "Usage-Form-Builder-Form-Builder" → "usage-form-builder").
 *
 * @param {string} normalized
 * @returns {string|null}
 */
function collapseRepeatedTail( normalized ) {
	const tokens = normalized.split( '-' );

	for ( let size = Math.floor( tokens.length / 2 ); 1 <= size; size-- ) {
		const tail     = tokens.slice( -size ).join( '-' );
		const previous = tokens.slice( -2 * size, -size ).join( '-' );

		if ( tail === previous ) {
			return tokens.slice( 0, -size ).join( '-' );
		}
	}

	return null;
}

/**
 * Slug and priority the docs site importer gives a file (GitHubDocsService::buildSlug()).
 *
 * @param {string} relativePath
 * @returns {{ slug: string, rank: number }}
 */
function importerSlug( relativePath ) {
	const segments    = relativePath.replace( /\.md$/i, '' ).split( '/' );
	const base        = segments[ segments.length - 1 ];
	const directories = segments.slice( 0, -1 );
	let slugSegments  = segments;
	let rank          = 1 === segments.length ? 1 : 0;

	if ( [ 'index', 'readme' ].includes( base.toLowerCase() ) ) {
		slugSegments = directories;
		rank         = 3;
	} else if ( 2 <= segments.length && siteKebab( segments[ segments.length - 2 ] ) === siteKebab( base ) ) {
		slugSegments = directories;
		rank         = 2;
	}

	return { slug: slugSegments.map( siteKebab ).join( '/' ) || 'home', rank };
}

/**
 * Turn a gitignore-style glob into a regular expression with PHP fnmatch() semantics (no FNM_PATHNAME).
 *
 * Pass the pattern through toBytes() and test byte strings, so `?` matches one byte like fnmatch() does.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegExp( pattern ) {
	let source = '';

	for ( let index = 0; index < pattern.length; index++ ) {
		const character = pattern[ index ];

		if ( '\\' === character && index + 1 < pattern.length ) {
			source += escapeRegExp( pattern[ ++index ] );
		} else if ( '*' === character ) {
			source += '.*';
		} else if ( '?' === character ) {
			source += '.';
		} else if ( '[' === character && pattern.indexOf( ']', index + 1 ) > index ) {
			const end   = pattern.indexOf( ']', index + 1 );
			const inner = pattern.slice( index + 1, end ).replace( /^!/, '^' ).replace( /\\/g, '\\\\' );
			source     += `[${ inner }]`;
			index       = end;
		} else {
			source += escapeRegExp( character );
		}
	}

	return new RegExp( `^${ source }$` );
}

/**
 * Read .docsignore patterns the way the docs site does.
 *
 * @returns {string[]}
 */
function readDocsIgnore() {
	const file = join( docsPath, '.docsignore' );

	if ( ! existsSync( file ) ) {
		return [];
	}

	return readFileSync( file, 'utf8' ).split( /\r?\n/ ).map( ( line ) => line.trim() ).filter( ( line ) => '' !== line && ! line.startsWith( '#' ) );
}

/**
 * Whether a docs-relative path matches a .docsignore pattern (GitHubDocsService::matchesIgnorePattern()).
 *
 * @param {string}   relativePath
 * @param {string[]} patterns
 * @returns {boolean}
 */
function matchesDocsIgnore( relativePath, patterns ) {
	const base = posix.basename( relativePath );

	return patterns.some( ( pattern ) => {
		if ( pattern.endsWith( '/' ) ) {
			const directory = pattern.replace( /\/+$/, '' );

			return relativePath.startsWith( `${ directory }/` ) || posix.dirname( relativePath ).split( '/' ).includes( directory );
		}

		const regex = globToRegExp( toBytes( pattern ) );

		return regex.test( toBytes( relativePath ) ) || regex.test( toBytes( base ) );
	} );
}

/**
 * Whether the importer skips a path because of its name, folders or .docsignore (not front matter).
 *
 * @param {string}   relativePath
 * @param {string[]} patterns
 * @returns {boolean}
 */
function isExcludedByPath( relativePath, patterns ) {
	const segments = relativePath.split( '/' );

	return /^[._]/.test( segments[ segments.length - 1 ] )
		|| segments.slice( 0, -1 ).some( ( segment ) => IMPORTER_IGNORED_DIRECTORIES.includes( segment.toLowerCase() ) )
		|| matchesDocsIgnore( relativePath, patterns );
}

/**
 * Why a .planning destination can't be used: a symlink or file in its path, or an existing file.
 *
 * @param {string} planningRoot
 * @param {string} path
 * @returns {'symlink'|'blocked'|'exists'|null}
 */
function planningProblem( planningRoot, path ) {
	let current = planningRoot;

	for ( const segment of [ '', ...path.split( '/' ).slice( 0, -1 ) ] ) {
		current = segment ? join( current, segment ) : current;

		if ( ! existsSync( current ) && ! isSymlink( current ) ) {
			return null;
		}

		const stats = lstatSync( current );

		if ( stats.isSymbolicLink() ) {
			return 'symlink';
		}

		if ( ! stats.isDirectory() ) {
			return 'blocked';
		}
	}

	const leaf = join( planningRoot, path );

	if ( isSymlink( leaf ) ) {
		return 'symlink';
	}

	return existsSync( leaf ) ? 'exists' : null;
}

/**
 * Whether a path is a symbolic link (including a dangling one).
 *
 * @param {string} path
 * @returns {boolean}
 */
function isSymlink( path ) {
	try {
		return lstatSync( path ).isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Front matter as the docs site reads it (GitHubDocsService::parseFrontMatter()), without YAML comment handling.
 *
 * @param {string} content
 * @returns {Record<string, string>}
 */
function importerFrontMatter( content ) {
	const match = content.match( /^---\s*\n([\s\S]*?)\n---\s*\n/ );
	const data  = {};

	if ( match ) {
		for ( const line of match[1].split( '\n' ) ) {
			const pair = line.match( /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/ );

			if ( pair ) {
				data[ pair[1].trim().toLowerCase() ] = pair[2].replace( /^[\s"']+|[\s"']+$/g, '' );
			}
		}
	}

	return data;
}

/**
 * List every file under a folder as POSIX paths relative to the docs folder.
 *
 * Symbolic links are never followed; they're collected separately.
 *
 * @param {string}   directory
 * @param {string[]} symlinks
 * @returns {string[]}
 */
function listFiles( directory, symlinks ) {
	const files = [];

	for ( const entry of readdirSync( directory, { withFileTypes: true } ) ) {
		const path         = join( directory, entry.name );
		const relativePath = relative( docsPath, path ).split( sep ).join( '/' );

		if ( entry.isSymbolicLink() ) {
			symlinks.push( relativePath );
		} else if ( entry.isDirectory() ) {
			files.push( ...listFiles( path, symlinks ) );
		} else {
			files.push( relativePath );
		}
	}

	return files;
}

/**
 * Work out where a file should live under the standard.
 *
 * @param {string} oldPath
 * @returns {{ path: string, planning: boolean, landing: boolean }}
 */
function targetPath( oldPath ) {
	const segments = oldPath.split( '/' );
	const internal = segments.slice( 0, -1 ).findIndex( ( segment ) => INTERNAL_DIRECTORIES.includes( segment.toLowerCase() ) );

	if ( -1 !== internal ) {
		return { path: segments.slice( internal ).join( '/' ), planning: true, landing: false };
	}

	const fileName  = segments.pop();
	const extension = extname( fileName ).toLowerCase();
	let stem        = kebab( fileName.slice( 0, fileName.length - extension.length ) );
	let directories = segments.map( kebab );

	if ( 0 < directories.length && DIRECTORY_RENAMES[ directories[0] ] ) {
		directories[0] = DIRECTORY_RENAMES[ directories[0] ];
	}

	if ( '.md' !== extension ) {
		return { path: [ ...directories, `${ stem }${ extension }` ].join( '/' ), planning: false, landing: false };
	}

	const originalStem = kebab( basename( oldPath, extname( oldPath ) ) );
	const parent       = segments.length ? kebab( segments[ segments.length - 1 ] ) : null;
	let landing        = false;

	if ( 0 < directories.length && ( [ 'index', 'readme' ].includes( stem ) || originalStem === parent ) ) {
		stem        = directories.pop();
		directories = directories.slice();
		landing     = true;
	} else if ( 0 === directories.length && [ 'index', 'readme' ].includes( stem ) ) {
		stem    = 'home';
		landing = true;
	}

	if ( 0 === directories.length && TOP_LEVEL_RENAMES[ stem ] ) {
		stem = TOP_LEVEL_RENAMES[ stem ];
	}

	return { path: [ ...directories, `${ stem }.md` ].join( '/' ), planning: false, landing };
}

/**
 * Split a page into front matter fields and body.
 *
 * @param {string} content
 * @returns {{ fields: Array<[string, string]>, body: string }}
 */
function splitPage( content ) {
	const normalized = content.replace( /\r\n/g, '\n' );
	const match      = normalized.match( /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/ );

	if ( ! match ) {
		return { fields: [], body: normalized };
	}

	const fields = [];

	for ( const line of match[1].split( '\n' ) ) {
		const pair = line.match( /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/ );

		if ( pair ) {
			fields.push( [ pair[1].toLowerCase(), parseScalar( pair[2] ) ] );
		}
	}

	return { fields, body: normalized.slice( match[0].length ) };
}

/**
 * Quote a front matter value when YAML would misread it.
 *
 * @param {string} value
 * @returns {string}
 */
function yamlValue( value ) {
	return /^[\w][\w\s.,()/'&+-]*$/.test( value ) && ! /:\s/.test( value ) ? value : JSON.stringify( value );
}

/**
 * Guess a code block's language from its first lines.
 *
 * @param {string[]} lines
 * @returns {string}
 */
function guessLanguage( lines ) {
	const code  = lines.join( '\n' ).trim();
	const first = code.split( '\n' )[0] ?? '';

	if ( /^<\?php/.test( code ) ) {
		return 'php';
	}

	if ( /@(if|foreach|livewire|props|php|section)\b|<x-[a-z]|\{\{\s*.*\s*\}\}|<livewire:/.test( code ) ) {
		return 'blade';
	}

	if ( /^(\$ )?(composer|php artisan|npm|npx|yarn|pnpm|git|cd|mkdir|cp|mv|curl|vendor\/bin|\.\/vendor)\b/.test( first ) ) {
		return 'bash';
	}

	if ( /^[A-Z][A-Z0-9_]+=/.test( first ) ) {
		return 'env';
	}

	if ( /^\s*[{[]/.test( code ) ) {
		try {
			JSON.parse( code );

			return 'json';
		} catch {
			// Not JSON.
		}
	}

	if ( /^(import |export |const |let |function |document\.|window\.)/.test( first ) ) {
		return /:\s*(string|number|boolean)\b|interface |type \w+ =/.test( code ) ? 'ts' : 'js';
	}

	if ( /(\$\w+|->|::|use [A-Z]\w+\\|namespace |function \w+\(|=>)/.test( code ) ) {
		return 'php';
	}

	return 'text';
}

/**
 * Humanize a slug segment into a Title Case title.
 *
 * @param {string} stem
 * @returns {string}
 */
function humanize( stem ) {
	const minor = [ 'a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with' ];

	return stem.split( '-' ).map( ( word, index ) => ( 0 < index && minor.includes( word ) ? word : word.charAt( 0 ).toUpperCase() + word.slice( 1 ) ) ).join( ' ' );
}

/**
 * Refuse to run against anything that isn't a docs folder inside a repository.
 */
function assertDocsFolder() {
	if ( ! ARCHETYPE_SLOTS[ archetype ] ) {
		fail( `Unknown archetype "${ archetype }". Use one of: ${ Object.keys( ARCHETYPE_SLOTS ).join( ', ' ) }.` );
	}

	if ( ! existsSync( docsPath ) && existsSync( backup ) ) {
		fail( `An earlier run stopped after moving docs/ to ${ backup }. Restore it first (mv "${ backup }" "${ docsPath }"), remove ${ staging } if it exists, then run again.` );
	}

	if ( ! existsSync( docsPath ) || ! lstatSync( docsPath ).isDirectory() ) {
		fail( `No docs folder at ${ docsPath }.` );
	}

	let worktree = null;

	try {
		worktree = execFileSync( 'git', [ '-C', docsPath, 'rev-parse', '--show-toplevel' ], { encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'ignore' ] } ).trim();
	} catch {
		// Not a git checkout; fall back to the .git check below.
	}

	if ( existsSync( join( docsPath, '.git' ) ) || ( worktree && realpathSync( worktree ) === realpathSync( docsPath ) ) ) {
		fail( `${ docsPath } is the repository root. Pass the docs folder instead (usually "docs").` );
	}
}

/**
 * Files under the docs folder that git can restore exactly: tracked, with no unstaged edits.
 *
 * @returns {Set<string>}
 */
function recoverableFiles() {
	const run = ( gitArgs ) => execFileSync( 'git', [ '-C', docsPath, ...gitArgs ], { encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'ignore' ] } ).split( '\0' ).filter( Boolean );

	try {
		const modified = new Set( run( [ 'diff', '--name-only', '--relative', '-z' ] ) );

		return new Set( run( [ 'ls-files', '-z' ] ).filter( ( file ) => ! modified.has( file ) ) );
	} catch {
		return new Set();
	}
}

/**
 * Build the migration plan and apply it when --write is set.
 */
function migrate() {
	assertDocsFolder();

	const symlinks       = [];
	const allFiles       = listFiles( docsPath, symlinks ).sort( compareBytes );
	const oldFiles       = [];
	const leftovers      = [];
	const ignorePatterns = readDocsIgnore();
	const hasDocsIgnore  = allFiles.includes( '.docsignore' );
	const planningRoot   = join( repoRoot, '.planning' );
	const fatal          = [];

	for ( const file of allFiles ) {
		if ( ! /^[._]/.test( posix.basename( file ) ) ) {
			oldFiles.push( file );
		} else if ( '.docsignore' !== file ) {
			leftovers.push( file );
		}
	}

	const oldFileSet = new Set( oldFiles );
	const pageFiles  = oldFiles.filter( ( file ) => file.toLowerCase().endsWith( '.md' ) );

	for ( const link of symlinks ) {
		note( `${ link } is a symbolic link. The script doesn't follow or move links; replace it with real files first.` );
	}

	if ( write && 0 < symlinks.length ) {
		fatal.push( `docs/ contains symbolic links (${ symlinks.join( ', ' ) }). Replace them with real files and run again.` );
	}

	/**
	 * Whether the docs site would publish a page (GitHubDocsService::shouldIgnore() and the draft/hidden check).
	 *
	 * @param {string} file
	 * @returns {boolean}
	 */
	const isPublishable = ( file ) => {
		if ( isExcludedByPath( file, ignorePatterns ) ) {
			return false;
		}

		const frontMatter = importerFrontMatter( readFileSync( join( docsPath, file ), 'utf8' ) );

		return ! [ frontMatter.draft, frontMatter.hidden ].some( ( value ) => [ 'true', '1', 'yes', 'on' ].includes( ( value ?? '' ).toLowerCase() ) );
	};

	const publishable = new Set( pageFiles.filter( isPublishable ) );
	const published   = new Map();

	for ( const file of pageFiles ) {
		if ( ! publishable.has( file ) ) {
			continue;
		}

		const { slug, rank } = importerSlug( file );

		if ( ! published.has( slug ) || rank > published.get( slug ).rank ) {
			published.set( slug, { file, rank } );
		}
	}

	const slugLookup = new Map();

	for ( const [ slug, { file } ] of published ) {
		if ( ! slugLookup.has( normalizeTarget( slug ) ) ) {
			slugLookup.set( normalizeTarget( slug ), file );
		}
	}

	const isPublishedWinner = ( file ) => file.toLowerCase().endsWith( '.md' ) && published.get( importerSlug( file ).slug )?.file === file;

	const moves         = new Map();
	const claimed       = new Map();
	const droppedWinner = new Map();

	const ordered = [ ...oldFiles ].sort( ( a, b ) => {
		const winnerA = isPublishedWinner( a ) ? 1 : 0;
		const winnerB = isPublishedWinner( b ) ? 1 : 0;

		if ( winnerA !== winnerB ) {
			return winnerB - winnerA;
		}

		const rankA = a.endsWith( '.md' ) ? importerSlug( a ).rank : 0;
		const rankB = b.endsWith( '.md' ) ? importerSlug( b ).rank : 0;

		if ( rankA !== rankB ) {
			return rankB - rankA;
		}

		const keepsNameA = targetPath( a ).path === a ? 0 : 1;
		const keepsNameB = targetPath( b ).path === b ? 0 : 1;

		return keepsNameA - keepsNameB;
	} );

	/**
	 * Keep a file at its current path, reserving that path so nothing else lands on it.
	 *
	 * @param {string} file
	 * @param {string} reason
	 */
	const leaveInPlace = ( file, reason ) => {
		const key = `docs:${ file.toLowerCase() }`;

		if ( claimed.has( key ) ) {
			fatal.push( `${ file } can't stay where it is because ${ claimed.get( key ) } is moving to that path. ${ reason }` );

			return;
		}

		claimed.set( key, file );
		moves.set( file, { ...targetPath( file ), path: file, planning: false, conflict: true } );
		note( `Left ${ file } in place: ${ reason }` );
	};

	for ( const file of ordered ) {
		const target = targetPath( file );
		const key    = `${ target.planning ? 'planning' : 'docs' }:${ target.path.toLowerCase() }`;

		if ( target.planning ) {
			const problem = planningProblem( planningRoot, target.path );

			if ( 'symlink' === problem ) {
				fatal.push( `.planning/${ target.path } goes through a symbolic link. Replace it with a real folder so files can't be written outside the repo.` );
			} else if ( problem ) {
				leaveInPlace( file, `.planning/${ target.path } ${ 'exists' === problem ? 'already exists' : 'is blocked by a file in its path' }. Merge the two by hand.` );

				continue;
			}
		}

		if ( claimed.has( key ) ) {
			const winner            = claimed.get( key );
			const isShadowedLanding = publishable.has( file ) && ! isPublishedWinner( file );

			if ( isShadowedLanding && importerSlug( winner ).slug === importerSlug( file ).slug ) {
				droppedWinner.set( file, winner );
				note( `Dropped ${ file }: the docs site already published ${ winner } in its place, so this copy was never shown. Check it for anything worth keeping.` );
			} else {
				leaveInPlace( file, `${ target.path } is already taken by ${ winner }. Merge the two by hand.` );
			}

			continue;
		}

		claimed.set( key, file );
		moves.set( file, target );
	}

	const newPathOf = ( oldFile ) => {
		if ( droppedWinner.has( oldFile ) ) {
			return newPathOf( droppedWinner.get( oldFile ) );
		}

		const move = moves.get( oldFile );

		return move && ! move.planning ? move.path : null;
	};

	const docsIgnoreAdditions = [];

	for ( const [ from, move ] of moves ) {
		if ( ! move.planning && move.path !== from && from.toLowerCase().endsWith( '.md' ) && isExcludedByPath( from, ignorePatterns ) && ! isExcludedByPath( move.path, ignorePatterns ) ) {
			docsIgnoreAdditions.push( move.path );
		}
	}

	if ( 0 < docsIgnoreAdditions.length ) {
		note( `Added ${ docsIgnoreAdditions.join( ', ' ) } to .docsignore so renamed pages stay unpublished.` );
	}

	const resolveOldTarget = ( currentOld, target ) => {
		const clean = safeDecode( target ).replace( /^\.\//, '' );

		const direct = posix.normalize( posix.join( posix.dirname( currentOld ), clean ) );

		for ( const candidate of [ direct, `${ direct }.md`, `${ direct }/${ posix.basename( direct ) }.md` ] ) {
			if ( oldFileSet.has( candidate ) ) {
				return candidate;
			}
		}

		const currentSlug = importerSlug( currentOld ).slug;
		const directory   = currentSlug.includes( '/' ) ? currentSlug.slice( 0, currentSlug.lastIndexOf( '/' ) ) : currentSlug;
		const stripped    = clean.replace( /\.md$/i, '' ).replace( /^(\.\.\/)+/, '' ).replace( /^\//, '' );

		for ( const candidate of [ stripped, `${ directory }/${ stripped }` ] ) {
			const normalized = normalizeTarget( candidate );
			const found      = slugLookup.get( normalized ) ?? slugLookup.get( collapseRepeatedTail( normalized ) ?? '' );

			if ( found ) {
				return found;
			}
		}

		return null;
	};

	const sourceUrl = ( currentOld, target ) => {
		if ( null === repositoryUrl ) {
			return null;
		}

		const inRepo = posix.normalize( posix.join( 'docs', posix.dirname( currentOld ), safeDecode( target ) ) );

		if ( inRepo.startsWith( '..' ) || inRepo.startsWith( 'docs/' ) || ! existsSync( join( repoRoot, inRepo ) ) ) {
			return null;
		}

		return `${ repositoryUrl }/${ inRepo.split( '/' ).map( encodeURIComponent ).join( '/' ) }`;
	};

	const relativeLink = ( fromNew, toNew ) => posix.relative( posix.dirname( fromNew ), toNew );

	const linkOrder = new Map();

	const recordLinkOrder = ( pageNew, targetNew ) => {
		if ( ! linkOrder.has( pageNew ) ) {
			linkOrder.set( pageNew, [] );
		}

		if ( ! linkOrder.get( pageNew ).includes( targetNew ) ) {
			linkOrder.get( pageNew ).push( targetNew );
		}
	};

	const rewritten  = new Map();
	const anchorRefs = [];

	/**
	 * Stand-in for a link's #fragment, resolved once every page's final H1 is known.
	 *
	 * @param {string} targetNew
	 * @param {string} fragment
	 * @returns {string}
	 */
	const anchorToken = ( targetNew, fragment ) => {
		anchorRefs.push( { targetNew, fragment } );

		return `\u0001${ anchorRefs.length - 1 }\u0001`;
	};
	let linksFixed   = 0;
	let linksBroken  = 0;
	let fencesTagged = 0;

	for ( const oldFile of pageFiles ) {
		const newFile = newPathOf( oldFile );

		if ( null === newFile || droppedWinner.has( oldFile ) ) {
			continue;
		}

		const { fields, body } = splitPage( readFileSync( join( docsPath, oldFile ), 'utf8' ) );
		const lines            = body.split( '\n' );
		const output           = [];
		let fence              = null;
		let fenceStart         = -1;
		let h1Count            = 0;
		let firstH1            = null;

		/**
		 * Rewrite one link target for the page's new location.
		 *
		 * @param {string}  target
		 * @param {boolean} isImage
		 * @returns {string}
		 */
		const rewriteTarget = ( target, isImage ) => {
			if ( /^(https?:|mailto:|tel:)/i.test( target ) ) {
				return target;
			}

			if ( target.startsWith( '#' ) ) {
				return anchorToken( newFile, target.slice( 1 ) );
			}

			const [ path, ...rest ] = target.split( /(?=[#?])/ );
			const suffix            = rest.join( '' );

			if ( '' === path ) {
				return target;
			}

			const found = resolveOldTarget( oldFile, path );

			if ( ! found || ! newPathOf( found ) ) {
				const external = sourceUrl( oldFile, path );

				if ( external ) {
					linksFixed++;

					return `${ external }${ suffix }`;
				}

				linksBroken++;

				return target;
			}

			const targetNew = newPathOf( found );
			const linkPath  = relativeLink( newFile, targetNew );

			if ( ! isImage ) {
				recordLinkOrder( newFile, targetNew );

			}

			if ( `${ linkPath }${ suffix }` !== target ) {
				linksFixed++;
			}

			return ! isImage && suffix.startsWith( '#' ) ? `${ linkPath }${ anchorToken( targetNew, suffix.slice( 1 ) ) }` : `${ linkPath }${ suffix }`;
		};

		for ( let index = 0; index < lines.length; index++ ) {
			let line     = lines[ index ];
			const quote  = line.match( BLOCKQUOTE_PREFIX )[0];
			const inner  = line.slice( quote.length );

			if ( null !== fence ) {
				const closing = inner.match( CLOSING_FENCE );

				if ( closing && closing[1][0] === fence[0] && closing[1].length >= fence.length ) {
					const openingLine = output[ fenceStart ];
					const prefix      = openingLine.match( BLOCKQUOTE_PREFIX )[0];
					const opening     = openingLine.slice( prefix.length ).match( OPENING_FENCE );

					if ( '' === opening[3].trim() ) {
						const body            = output.slice( fenceStart + 1 ).map( ( codeLine ) => codeLine.replace( BLOCKQUOTE_PREFIX, '' ) );
						output[ fenceStart ] = `${ prefix }${ opening[1] }${ opening[2] }${ guessLanguage( body ) }`;
						fencesTagged++;
					}

					fence = null;
				}

				output.push( line );

				continue;
			}

			const opening = inner.match( OPENING_FENCE );

			if ( opening && ! ( '`' === opening[2][0] && opening[3].includes( '`' ) ) ) {
				fence      = opening[2];
				fenceStart = output.length;
				output.push( line );

				continue;
			}

			const alert = line.match( /^(\s{0,3}>)\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i );

			if ( alert && /^\s{0,3}>/.test( lines[ index + 1 ] ?? '' ) ) {
				const next = lines[ ++index ].replace( /^\s{0,3}>\s?/, '' );
				line       = `${ alert[1] } **${ ALERT_LABELS[ alert[2].toUpperCase() ] }:** ${ next }`;
			}

			if ( /^#\s+/.test( line ) ) {
				h1Count++;

				if ( 1 === h1Count ) {
					firstH1 = output.length;
				} else {
					line = `#${ line }`;
				}
			}

			const codeSpans = [];
			line            = line.replace( /`[^`]*`/g, ( span ) => {
				codeSpans.push( span );

				return `\u0000${ codeSpans.length - 1 }\u0000`;
			} );

			const definition = line.match( /^(\s{0,3}\[[^\]^][^\]]*\]:[ \t]*)(<?)([^\s>]+)(>?)(.*)$/ );

			if ( definition ) {
				const isImage = IMAGE_EXTENSIONS.includes( extname( definition[3].split( /[#?]/ )[0] ).toLowerCase() );
				line          = `${ definition[1] }${ definition[2] }${ rewriteTarget( definition[3], isImage ) }${ definition[4] }${ definition[5] }`;
			} else {
				line = line.replace( /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, ( whole, page, text ) => {
					const found = resolveOldTarget( oldFile, page.trim() );

					if ( ! found || ! newPathOf( found ) ) {
						linksBroken++;

						return whole;
					}

					linksFixed++;
					recordLinkOrder( newFile, newPathOf( found ) );

					return `[${ ( text ?? page ).trim() }](${ relativeLink( newFile, newPathOf( found ) ) })`;
				} );

				line = line.replace( /(!?)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?((?:\s+"[^"]*")?)\s*\)/g, ( whole, bang, text, target, linkTitle ) => `${ bang }[${ text }](${ rewriteTarget( target, '!' === bang ) }${ linkTitle })` );
			}

			line = line.replace( /\u0000(\d+)\u0000/g, ( placeholder, position ) => codeSpans[ Number( position ) ] );

			output.push( line );
		}

		if ( 1 < h1Count ) {
			note( `${ newFile }: demoted ${ h1Count - 1 } extra H1(s) to H2. Check the heading levels below them.` );
		}

		rewritten.set( newFile, { oldFile, fields, lines: output, firstH1 } );
	}

	const assignOrder = ( pages, parentPage, start, step ) => {
		const preferred = linkOrder.get( parentPage ) ?? [];
		const position  = ( page ) => preferred.findIndex( ( target ) => target === page || target.startsWith( page.replace( /\.md$/, '/' ) ) );
		const existing  = ( page ) => {
			const value = rewritten.get( page )?.fields.find( ( [ key ] ) => 'menu_order' === key )?.[1];

			return /^-?\d+$/.test( value ?? '' ) ? Number( value ) : Infinity;
		};

		return [ ...pages ].sort( ( a, b ) => {
			const positionA = position( a );
			const positionB = position( b );

			if ( positionA !== positionB ) {
				return ( -1 === positionA ? Infinity : positionA ) - ( -1 === positionB ? Infinity : positionB );
			}

			if ( existing( a ) !== existing( b ) ) {
				return existing( a ) - existing( b );
			}

			return a.localeCompare( b );
		} ).map( ( page, index ) => [ page, start + ( index * step ) ] );
	};

	const menuOrders = new Map();
	const topLevel   = [ ...rewritten.keys() ].filter( ( page ) => ! page.includes( '/' ) );
	const custom     = topLevel.filter( ( page ) => undefined === slots[ page.replace( /\.md$/, '' ) ] );

	for ( const page of topLevel ) {
		const slot = slots[ page.replace( /\.md$/, '' ) ];

		if ( undefined !== slot ) {
			menuOrders.set( page, slot );
		}
	}

	const customStart = Object.values( slots ).includes( 40 ) ? 45 : 40;
	const customStep  = Math.max( 1, Math.min( 5, Math.floor( ( 79 - customStart ) / Math.max( 1, custom.length - 1 ) ) ) );

	for ( const [ page, order ] of assignOrder( custom, 'home.md', customStart, customStep ) ) {
		menuOrders.set( page, Math.min( order, 79 ) );
	}

	const byDirectory = new Map();

	for ( const page of rewritten.keys() ) {
		if ( page.includes( '/' ) ) {
			const directory = posix.dirname( page );
			byDirectory.set( directory, [ ...( byDirectory.get( directory ) ?? [] ), page ] );
		}
	}

	for ( const [ directory, pages ] of byDirectory ) {
		for ( const [ page, order ] of assignOrder( pages, `${ directory }.md`, 10, 10 ) ) {
			menuOrders.set( page, order );
		}

		if ( ! rewritten.has( `${ directory }.md` ) ) {
			note( `${ directory }/ has no landing page. Write ${ directory }.md introducing the section and linking to each page.` );
		}
	}

	const titles        = new Map();
	const anchorChanges = new Map();
	let anchorsFixed    = 0;

	/**
	 * Replace anchor tokens with their fragment, updated to the target's new H1 anchor when asked.
	 *
	 * @param {string}  line
	 * @param {boolean} applyChanges
	 * @returns {string}
	 */
	const restoreAnchors = ( line, applyChanges ) => line.replace( /\u0001(\d+)\u0001/g, ( token, id ) => {
		const ref    = anchorRefs[ Number( id ) ];
		const change = applyChanges ? anchorChanges.get( ref.targetNew ) : null;

		if ( change && ref.fragment === change.from ) {
			anchorsFixed++;

			return `#${ change.to }`;
		}

		return `#${ ref.fragment }`;
	} );

	for ( const [ newFile, page ] of rewritten ) {
		const stem     = posix.basename( newFile, '.md' );
		const fieldMap = new Map( page.fields );
		const h1Line   = null === page.firstH1 ? null : restoreAnchors( page.lines[ page.firstH1 ], false );
		const h1Text   = h1Line ? h1Line.replace( /^#\s+/, '' ).replace( /\s+#*\s*$/, '' ).trim() : null;
		const title    = ( ! newFile.includes( '/' ) && STANDARD_TITLES[ stem ] ) || fieldMap.get( 'title' ) || h1Text || humanize( stem );

		titles.set( newFile, title );

		if ( null !== h1Text && githubAnchor( h1Text ) !== githubAnchor( title ) ) {
			anchorChanges.set( newFile, { from: githubAnchor( h1Text ), to: githubAnchor( title ) } );
		}
	}

	for ( const page of rewritten.values() ) {
		page.lines = page.lines.map( ( line ) => restoreAnchors( line, true ) );
	}

	const contents = new Map();

	for ( const [ newFile, page ] of rewritten ) {
		const fieldMap  = new Map( page.fields );
		const title     = titles.get( newFile );
		const oldSlug   = importerSlug( page.oldFile ).slug;
		const newSlug   = importerSlug( newFile ).slug;
		const redirects = new Set( ( fieldMap.get( 'redirect_from' ) ?? '' ).split( ',' ).map( ( value ) => value.trim() ).filter( Boolean ) );

		if ( oldSlug !== newSlug && published.get( oldSlug )?.file === page.oldFile ) {
			redirects.add( oldSlug );
		}

		const front = [ '---', `title: ${ yamlValue( title ) }`, `menu_order: ${ menuOrders.get( newFile ) }` ];

		for ( const [ key, value ] of page.fields ) {
			if ( ! [ 'title', 'menu_order', 'redirect_from', 'parent' ].includes( key ) ) {
				front.push( `${ key }: ${ yamlValue( value ) }` );
			}
		}

		if ( 0 < redirects.size ) {
			front.push( `redirect_from: ${ [ ...redirects ].join( ', ' ) }` );
		}

		front.push( '---' );

		const lines = [ ...page.lines ];

		if ( null === page.firstH1 ) {
			while ( '' === lines[0]?.trim() ) {
				lines.shift();
			}

			lines.unshift( `# ${ title }`, '' );
		} else {
			lines[ page.firstH1 ] = `# ${ title }`;
		}

		while ( '' === lines[0]?.trim() ) {
			lines.shift();
		}

		contents.set( newFile, `${ front.join( '\n' ) }\n\n${ lines.join( '\n' ).replace( /\n*$/, '\n' ) }` );
	}

	const recoverable    = recoverableFiles();
	const removed        = [ ...droppedWinner.keys(), ...leftovers ];
	const preserved      = removed.filter( ( file ) => ! recoverable.has( file ) && '.DS_Store' !== posix.basename( file ) );
	const preservedPaths = new Map( preserved.map( ( file ) => [ file, `removed-docs/${ file }` ] ) );

	for ( const [ file, path ] of preservedPaths ) {
		const problem = planningProblem( planningRoot, path );

		if ( problem ) {
			fatal.push( `${ file } can't be restored from git (untracked or edited), and .planning/${ path } ${ 'symlink' === problem ? 'goes through a symbolic link' : 'is taken' }, so there's nowhere safe to keep it. Move one of them first.` );
		}
	}

	const renamed  = [ ...moves ].filter( ( [ from, move ] ) => move.path !== from || move.planning );
	const planning = renamed.filter( ( [ , move ] ) => move.planning );

	console.log( `Docs migration plan for ${ relative( process.cwd(), docsPath ) || '.' } (${ archetype })${ write ? '' : ' (dry run)' }\n` );

	for ( const [ from, move ] of renamed ) {
		console.log( `  ${ from } → ${ move.planning ? `.planning/${ move.path }` : move.path }` );
	}

	for ( const file of removed ) {
		const reason = droppedWinner.has( file ) ? 'never published' : "the standard doesn't need it";
		const kept   = preservedPaths.has( file ) ? `, untracked so kept in .planning/${ preservedPaths.get( file ) }` : '';

		console.log( `  ${ file } → (removed: ${ reason }${ kept })` );
	}

	console.log( `\n  ${ renamed.length - planning.length } page(s) renamed, ${ planning.length } internal file(s) moved to .planning/, ${ droppedWinner.size } shadowed page(s) removed.` );
	console.log( `  ${ contents.size } page(s) normalized, ${ linksFixed } link(s) rewritten, ${ anchorsFixed } anchor(s) updated, ${ fencesTagged } code block(s) tagged.` );

	if ( 0 < linksBroken ) {
		note( `${ linksBroken } link(s) couldn't be resolved to a page and were left as they are. docs-lint will list them.` );
	}

	if ( notes.length ) {
		console.log( '\nNeeds a look:' );

		for ( const message of notes ) {
			console.log( `  - ${ message }` );
		}
	}

	if ( fatal.length ) {
		console.log( `\n${ write ? "Can't apply" : 'Must be fixed before --write' }:` );

		for ( const message of fatal ) {
			console.log( `  - ${ message }` );
		}
	}

	if ( ! write ) {
		console.log( '\nRun again with --write to apply.' );

		return;
	}

	if ( fatal.length ) {
		process.exit( 1 );
	}

	if ( existsSync( backup ) ) {
		fail( `${ backup } already exists, so an earlier run was interrupted. It holds the original docs/: check it for files you need, remove it, then run again.` );
	}

	try {
		mkdirSync( staging );
	} catch ( error ) {
		fail( 'EEXIST' === error.code ? `${ staging } already exists: another run is in progress or an earlier one was interrupted. Check it for files you need, remove it, then run again.` : error.message );
	}

	const writeStaged = ( destination, write ) => {
		mkdirSync( dirname( destination ), { recursive: true } );
		write( destination );
	};

	try {
		mkdirSync( join( staging, 'docs' ) );

		for ( const [ from, move ] of moves ) {
			const destination = move.planning ? join( staging, 'planning', move.path ) : join( staging, 'docs', move.path );

			if ( contents.has( move.path ) && ! move.planning && from.toLowerCase().endsWith( '.md' ) && rewritten.get( move.path )?.oldFile === from ) {
				writeStaged( destination, ( path ) => writeFileSync( path, contents.get( move.path ), { flag: 'wx' } ) );
			} else {
				writeStaged( destination, ( path ) => copyFileSync( join( docsPath, from ), path, constants.COPYFILE_EXCL ) );
			}
		}

		for ( const [ file, path ] of preservedPaths ) {
			writeStaged( join( staging, 'planning', path ), ( destination ) => copyFileSync( join( docsPath, file ), destination, constants.COPYFILE_EXCL ) );
		}

		if ( hasDocsIgnore || 0 < docsIgnoreAdditions.length ) {
			const original  = hasDocsIgnore ? readFileSync( join( docsPath, '.docsignore' ), 'utf8' ) : '';
			const base      = original ? `${ original.replace( /\n*$/, '\n' ) }\n` : '';
			const additions = 0 < docsIgnoreAdditions.length ? `${ base }# Renamed by docs-migrate\n${ docsIgnoreAdditions.join( '\n' ) }\n` : original;

			writeStaged( join( staging, 'docs', '.docsignore' ), ( path ) => writeFileSync( path, additions, { flag: 'wx' } ) );
		}
	} catch ( error ) {
		rmSync( staging, { recursive: true, force: true } );
		fail( `Stopped before changing anything: ${ 'EEXIST' === error.code ? `two files would be written to ${ relative( staging, error.dest ?? error.path ?? '' ) }. Rename one of them first.` : error.message }` );
	}

	const planningFiles = existsSync( join( staging, 'planning' ) ) ? listFilesUnder( join( staging, 'planning' ) ) : [];
	const blocked       = planningFiles.filter( ( file ) => planningProblem( planningRoot, file ) );

	if ( blocked.length ) {
		rmSync( staging, { recursive: true, force: true } );
		fail( `Stopped before changing anything: ${ blocked.map( ( file ) => `.planning/${ file }` ).join( ', ' ) } can't be written (taken, blocked by a file, or behind a symbolic link).` );
	}

	renameSync( docsPath, backup );

	try {
		renameSync( join( staging, 'docs' ), docsPath );
	} catch ( error ) {
		renameSync( backup, docsPath );
		throw error;
	}

	const moved = [];

	try {
		for ( const file of planningFiles ) {
			const destination = join( planningRoot, file );

			if ( planningProblem( planningRoot, file ) ) {
				throw new Error( `.planning/${ file } changed while the script was running.` );
			}

			mkdirSync( dirname( destination ), { recursive: true } );
			renameSync( join( staging, 'planning', file ), destination );
			moved.push( file );
		}
	} catch ( error ) {
		const remaining = planningFiles.filter( ( file ) => ! moved.includes( file ) );

		console.log( `\nInstalled the new docs/, but moving files into .planning/ failed: ${ error.message }` );
		console.log( `  Moved: ${ moved.join( ', ' ) || 'none' }` );
		console.log( `  Still in ${ join( staging, 'planning' ) }: ${ remaining.join( ', ' ) }` );
		console.log( `  The original docs/ is in ${ backup }. Move the remaining files by hand, then delete both folders.` );
		process.exit( 1 );
	}

	rmSync( backup, { recursive: true, force: true } );
	rmSync( staging, { recursive: true, force: true } );
	console.log( '\nApplied. Review the diff, then run docs-lint.mjs.' );
}

/**
 * List files under any folder, relative to it.
 *
 * @param {string} directory
 * @returns {string[]}
 */
function listFilesUnder( directory ) {
	const files = [];

	for ( const entry of readdirSync( directory, { withFileTypes: true } ) ) {
		if ( entry.isDirectory() ) {
			files.push( ...listFilesUnder( join( directory, entry.name ) ).map( ( file ) => join( entry.name, file ) ) );
		} else {
			files.push( entry.name );
		}
	}

	return files;
}

migrate();
