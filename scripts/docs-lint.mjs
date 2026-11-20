#!/usr/bin/env node

/**
 * ArtisanPack UI docs linter.
 *
 * Checks a package's docs/ folder against DOCS_STANDARD.md in the
 * ArtisanPack-UI/.github repository. It has no dependencies, so any
 * Node 18+ install can run it.
 *
 * Usage:
 *   node docs-lint.mjs [docs-path] [--archetype=package|component-library|starter-kit|meta]
 *
 * Exits with 1 when any error is found. Warnings never fail the run.
 *
 * @since 1.0.0
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const IMAGE_EXTENSIONS = [ '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif' ];

const INTERNAL_DIRECTORIES = [ 'plans', 'audits', 'design', 'benchmarks', 'decisions', 'notes', 'drafts' ];

/**
 * Fixed menu_order values for the standard top-level pages.
 */
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

const PACKAGE_SPECIFIC_RANGE = [ 40, 79 ];

const REQUIRED_PAGES = {
	package: [ 'home', 'getting-started', 'installation', 'usage', 'reference', 'faq', 'troubleshooting' ],
	'component-library': [ 'home', 'getting-started', 'installation', 'components', 'faq', 'troubleshooting' ],
	'starter-kit': [ 'home', 'getting-started', 'installation', 'deployment', 'faq', 'troubleshooting' ],
	meta: [ 'home', 'installation' ],
};

/**
 * Top-level file names that have a standard replacement.
 */
const RENAMED_TOP_LEVEL_PAGES = {
	api: 'reference.md',
	'api-reference': 'reference.md',
	'quick-start': 'getting-started.md',
	overview: 'home.md (or getting-started.md)',
	upgrade: 'upgrading.md',
	upgrade_guide: 'upgrading.md',
	'upgrade-guide': 'upgrading.md',
};

const ALERT = /^\s{0,3}>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i;

const OPENING_FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const CLOSING_FENCE = /^\s{0,3}(`{3,}|~{3,})[ \t]*$/;

const args         = process.argv.slice( 2 );
const archetypeArg = args.find( ( arg ) => arg.startsWith( '--archetype=' ) );
const archetype    = archetypeArg ? archetypeArg.split( '=' )[1] : 'package';
const docsPath     = resolve( args.find( ( arg ) => ! arg.startsWith( '--' ) ) ?? 'docs' );
const inActions    = 'true' === process.env.GITHUB_ACTIONS;

const problems = [];

/**
 * Record a lint problem.
 *
 * @param {'error'|'warning'} level
 * @param {string}            file    Absolute path of the offending file or folder.
 * @param {string}            message
 * @param {number|null}       line
 */
function report( level, file, message, line = null ) {
	problems.push( { level, file, message, line } );
}

/**
 * Display path relative to the working directory.
 *
 * @param {string} file
 * @returns {string}
 */
function display( file ) {
	return relative( process.cwd(), file ) || '.';
}

/**
 * Recursively list every entry under a folder.
 *
 * @param {string} directory
 * @returns {{ path: string, isDirectory: boolean }[]}
 */
function walk( directory ) {
	const entries = [];

	for ( const name of readdirSync( directory ).sort() ) {
		const path        = join( directory, name );
		const isDirectory = statSync( path ).isDirectory();

		entries.push( { path, isDirectory } );

		if ( isDirectory ) {
			entries.push( ...walk( path ) );
		}
	}

	return entries;
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
 * Read a YAML scalar: unwrap quotes, or drop a trailing comment from a plain value.
 *
 * @param {string} raw
 * @returns {string}
 */
function parseScalar( raw ) {
	const value = raw.trim();
	const quote = value[0];

	if ( '"' === quote || "'" === quote ) {
		const end = value.indexOf( quote, 1 );

		return -1 === end ? value.slice( 1 ) : value.slice( 1, end );
	}

	return value.replace( /\s+#.*$/, '' ).trim();
}

/**
 * Normalize heading or title text for comparison, ignoring inline-code backticks.
 *
 * @param {string} text
 * @returns {string}
 */
function headingText( text ) {
	return text.replace( /`/g, '' ).replace( /\s+/g, ' ' ).trim();
}

/**
 * Split a page into its front matter fields and body lines.
 *
 * @param {string} content
 * @returns {{ frontMatter: Record<string, string>|null, body: string[], bodyStart: number }}
 */
function parsePage( content ) {
	const lines = content.replace( /\r\n/g, '\n' ).split( '\n' );

	if ( '---' !== lines[0]?.trim() ) {
		return { frontMatter: null, body: lines, bodyStart: 1 };
	}

	const end = lines.findIndex( ( line, index ) => 0 < index && '---' === line.trim() );

	if ( -1 === end ) {
		return { frontMatter: null, body: lines, bodyStart: 1 };
	}

	const frontMatter = {};

	for ( const line of lines.slice( 1, end ) ) {
		const match = line.match( /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/ );

		if ( match ) {
			frontMatter[ match[1].toLowerCase() ] = parseScalar( match[2] );
		}
	}

	return { frontMatter, body: lines.slice( end + 1 ), bodyStart: end + 2 };
}

/**
 * Check one markdown page's contents.
 *
 * @param {string} file
 * @returns {{ title: string|null, menuOrder: number|null }}
 */
function lintPage( file ) {
	const { frontMatter, body, bodyStart } = parsePage( readFileSync( file, 'utf8' ) );

	let title     = null;
	let menuOrder = null;

	if ( null === frontMatter ) {
		report( 'error', file, 'Missing front matter. Add a --- block with `title` and `menu_order`.', 1 );
	} else {
		title = frontMatter.title || null;

		if ( ! title ) {
			report( 'error', file, 'Front matter is missing `title`.', 1 );
		}

		if ( undefined === frontMatter.menu_order || '' === frontMatter.menu_order ) {
			report( 'error', file, 'Front matter is missing `menu_order`.', 1 );
		} else if ( ! /^-?\d+$/.test( frontMatter.menu_order ) ) {
			report( 'error', file, '`menu_order` must be a whole number.', 1 );
		} else {
			menuOrder = Number( frontMatter.menu_order );
		}

		if ( frontMatter.parent ) {
			report( 'warning', file, 'Avoid `parent` in front matter. Let the folder structure set the hierarchy.', 1 );
		}
	}

	const headings = [];
	let fence      = null;

	body.forEach( ( rawLine, index ) => {
		const lineNumber = bodyStart + index;

		if ( null !== fence ) {
			const closing = rawLine.match( CLOSING_FENCE );

			if ( closing && closing[1][0] === fence[0] && closing[1].length >= fence.length ) {
				fence = null;
			}

			return;
		}

		const opening = rawLine.match( OPENING_FENCE );

		if ( opening && ! ( '`' === opening[1][0] && opening[2].includes( '`' ) ) ) {
			fence = opening[1];

			if ( '' === opening[2].trim() ) {
				report( 'error', file, 'Code block has no language. Tag it (use `text` for plain output).', lineNumber );
			}

			return;
		}

		const line = rawLine.replace( /`[^`]*`/g, ( code ) => ' '.repeat( code.length ) );

		if ( /^#\s+/.test( line ) ) {
			headings.push( { text: headingText( rawLine.replace( /^#\s+/, '' ).replace( /\s+#*\s*$/, '' ) ), lineNumber } );
		}

		if ( ALERT.test( line ) ) {
			report( 'error', file, 'GitHub alert syntax does not render on docs.artisanpackui.dev. Use `> **Note:** ...` instead.', lineNumber );
		}

		if ( /\[\[[^\]]+\]\]/.test( line ) ) {
			report( 'error', file, 'Wiki-style [[link]] found. Use a relative markdown link to the .md file.', lineNumber );
		}

		for ( const match of line.matchAll( /(!?)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g ) ) {
			lintLink( file, match[2], '!' === match[1], lineNumber );
		}

		const definition = line.match( /^\s{0,3}\[[^\]^][^\]]*\]:[ \t]*<?([^\s>]+)>?/ );

		if ( definition ) {
			const isImage = IMAGE_EXTENSIONS.includes( extname( safeDecode( definition[1].split( /[#?]/ )[0] ) ).toLowerCase() );
			lintLink( file, definition[1], isImage, lineNumber );
		}
	} );

	if ( 0 === headings.length ) {
		report( 'error', file, 'Page has no H1. Add one `# Heading` that matches the title.', bodyStart );
	} else {
		headings.slice( 1 ).forEach( ( heading ) => {
			report( 'error', file, 'Page has more than one H1. Use `##` for sections.', heading.lineNumber );
		} );

		if ( title && headings[0].text !== headingText( title ) ) {
			report( 'error', file, `H1 "${ headings[0].text }" does not match the title "${ title }".`, headings[0].lineNumber );
		}
	}

	return { title, menuOrder };
}

/**
 * Check a single link target.
 *
 * @param {string}  file
 * @param {string}  target
 * @param {boolean} isImage
 * @param {number}  lineNumber
 */
function lintLink( file, target, isImage, lineNumber ) {
	if ( /^(https?:|mailto:|tel:|#)/i.test( target ) ) {
		return;
	}

	if ( target.startsWith( '/' ) ) {
		report( 'error', file, `Link "${ target }" is root-relative. Use a path relative to this page.`, lineNumber );

		return;
	}

	const path = safeDecode( target.split( /[#?]/ )[0] );

	if ( '' === path ) {
		return;
	}

	if ( ! isImage && '.md' !== extname( path ).toLowerCase() ) {
		report( 'error', file, `Link "${ target }" must point at a .md file (wiki-style links are not allowed).`, lineNumber );

		return;
	}

	const absolute = normalize( resolve( dirname( file ), path ) );

	if ( ! absolute.startsWith( docsPath + sep ) ) {
		report( 'error', file, `Link "${ target }" points outside the docs folder. Use a full https:// URL instead.`, lineNumber );

		return;
	}

	if ( ! existsSync( absolute ) ) {
		report( 'error', file, `Link "${ target }" points at a file that does not exist.`, lineNumber );
	}
}

/**
 * Run every check against the docs folder.
 */
function lint() {
	if ( ! REQUIRED_PAGES[ archetype ] ) {
		console.error( `Unknown archetype "${ archetype }". Use one of: ${ Object.keys( REQUIRED_PAGES ).join( ', ' ) }.` );
		process.exit( 2 );
	}

	if ( ! existsSync( docsPath ) || ! statSync( docsPath ).isDirectory() ) {
		report( 'error', docsPath, 'No docs folder found. Every package needs one.' );

		return;
	}

	const pages   = new Map();
	const skipped = [];

	for ( const { path, isDirectory } of walk( docsPath ) ) {
		if ( skipped.some( ( directory ) => path.startsWith( directory + sep ) ) ) {
			continue;
		}

		const name     = basename( path );
		const depth    = relative( docsPath, path ).split( sep ).length;
		const parent   = basename( dirname( path ) );
		const topLevel = 1 === depth;

		if ( isDirectory ) {
			if ( name.startsWith( '.' ) ) {
				report( 'error', path, 'Hidden folders do not belong in docs/.' );
				skipped.push( path );
				continue;
			}

			if ( INTERNAL_DIRECTORIES.includes( name.toLowerCase() ) ) {
				report( 'error', path, 'Internal files do not belong in docs/. Move this folder to .planning/ at the repo root.' );
				skipped.push( path );
				continue;
			}

			if ( ! KEBAB.test( name ) ) {
				report( 'error', path, 'Folder names must be kebab-case.' );
			}

			if ( 'images' !== name && ! existsSync( `${ path }.md` ) && ! existsSync( join( path, `${ name }.md` ) ) ) {
				report( 'error', path, `Section folder has no landing page. Add ${ name }.md beside it.` );
			}

			if ( topLevel && 'api' === name.toLowerCase() ) {
				report( 'error', path, 'Rename the api/ section to reference/.' );
			}

			continue;
		}

		const extension = extname( name ).toLowerCase();
		const stem      = name.slice( 0, name.length - extension.length );

		if ( name.startsWith( '.' ) || name.startsWith( '_' ) ) {
			const level = '.docsignore' === name ? 'warning' : 'error';
			report( level, path, '.docsignore' === name
				? '.docsignore should not be needed once internal files live outside docs/.'
				: 'Hidden and underscore-prefixed files do not belong in docs/.' );
			continue;
		}

		if ( IMAGE_EXTENSIONS.includes( extension ) ) {
			if ( ! KEBAB.test( stem ) ) {
				report( 'error', path, 'Image file names must be kebab-case.' );
			}

			continue;
		}

		if ( '.md' !== extension ) {
			report( 'error', path, 'Only .md pages and images belong in docs/.' );
			continue;
		}

		const lowerStem = stem.toLowerCase();

		if ( [ 'readme', 'index' ].includes( lowerStem ) ) {
			report( 'error', path, `Section landing pages live beside their folder (e.g. usage.md next to usage/), not in ${ name }.` );
		}

		if ( 'changelog' === lowerStem ) {
			report( 'error', path, 'Changelogs belong in CHANGELOG.md at the repo root.' );
		}

		if ( 'contributing' === lowerStem ) {
			report( 'error', path, 'Contributor docs belong in CONTRIBUTING.md at the repo root.' );
		}

		if ( ! topLevel && lowerStem === parent.toLowerCase() ) {
			report( 'error', path, `Duplicate section landing page. Move its content into ${ parent }.md beside the folder and delete this file.` );
		}

		if ( ! KEBAB.test( stem ) ) {
			report( 'error', path, `File names must be kebab-case (e.g. ${ stem.replace( /([a-z0-9])([A-Z])/g, '$1-$2' ).replace( /[\s_]+/g, '-' ).toLowerCase() }.md).` );
		}

		if ( topLevel ) {
			if ( RENAMED_TOP_LEVEL_PAGES[ lowerStem ] ) {
				report( 'error', path, `Rename to ${ RENAMED_TOP_LEVEL_PAGES[ lowerStem ] }.` );
			} else if ( /^upgrad(e|ing)-/.test( lowerStem ) ) {
				report( 'error', path, 'Fold per-version upgrade pages into upgrading.md (one ## heading per version), or upgrading/vN.md for long major-version guides.' );
			} else if ( 'migration' === lowerStem ) {
				report( 'warning', path, 'If this covers upgrading between versions, rename it to upgrading.md. If it covers moving from another tool, move it under usage/.' );
			} else if ( 'testing' === lowerStem ) {
				report( 'warning', path, 'Testing your app with the package belongs in advanced/testing.md. Contributor testing belongs in CONTRIBUTING.md.' );
			}
		}

		pages.set( path, { ...lintPage( path ), topLevel, stem: lowerStem } );
	}

	for ( const required of REQUIRED_PAGES[ archetype ] ) {
		if ( ! existsSync( join( docsPath, `${ required }.md` ) ) ) {
			report( 'error', docsPath, `Missing required page ${ required }.md for the "${ archetype }" archetype.` );
		}
	}

	const siblings = new Map();
	const slots    = { ...STANDARD_SLOTS, ...ARCHETYPE_SLOTS[ archetype ] };

	for ( const [ path, page ] of pages ) {
		if ( null === page.menuOrder ) {
			continue;
		}

		if ( page.topLevel ) {
			const slot = slots[ page.stem ];

			if ( undefined !== slot && page.menuOrder !== slot ) {
				report( 'error', path, `${ page.stem }.md must use menu_order: ${ slot }.`, 1 );
			}

			if ( undefined === slot && ( page.menuOrder < PACKAGE_SPECIFIC_RANGE[0] || page.menuOrder > PACKAGE_SPECIFIC_RANGE[1] ) ) {
				report( 'error', path, `Package-specific top-level pages use menu_order ${ PACKAGE_SPECIFIC_RANGE[0] }–${ PACKAGE_SPECIFIC_RANGE[1] }.`, 1 );
			}
		}

		const key = `${ dirname( path ) }:${ page.menuOrder }`;

		if ( siblings.has( key ) ) {
			report( 'warning', path, `Shares menu_order ${ page.menuOrder } with ${ basename( siblings.get( key ) ) }, so their order is undefined.`, 1 );
		} else {
			siblings.set( key, path );
		}
	}
}

lint();

const errors   = problems.filter( ( problem ) => 'error' === problem.level );
const warnings = problems.filter( ( problem ) => 'warning' === problem.level );

for ( const problem of problems ) {
	const location = problem.line ? `${ display( problem.file ) }:${ problem.line }` : display( problem.file );

	if ( inActions ) {
		const line = problem.line ? `,line=${ problem.line }` : '';
		console.log( `::${ problem.level } file=${ display( problem.file ) }${ line }::${ problem.message }` );
	} else {
		console.log( `${ 'error' === problem.level ? '✖' : '⚠' } ${ location }  ${ problem.message }` );
	}
}

console.log( `\nDocs lint (${ archetype }): ${ errors.length } error(s), ${ warnings.length } warning(s) in ${ display( docsPath ) }.` );

process.exit( 0 < errors.length ? 1 : 0 );
