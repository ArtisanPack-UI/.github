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
 *   node docs-migrate.mjs [docs-path]            # dry run: print the plan
 *   node docs-migrate.mjs [docs-path] --write    # apply it
 *
 * @since 1.0.0
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, posix, relative, resolve, sep } from 'node:path';

const INTERNAL_DIRECTORIES = [ 'plans', 'audits', 'design', 'benchmarks', 'decisions', 'notes', 'drafts' ];

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

const args     = process.argv.slice( 2 );
const write    = args.includes( '--write' );
const docsPath = resolve( args.find( ( arg ) => ! arg.startsWith( '--' ) ) ?? 'docs' );
const repoRoot = dirname( docsPath );

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
 * Convert any name to kebab-case.
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
 * Normalize a slug or link target the way the docs site importer does.
 *
 * @param {string} value
 * @returns {string}
 */
function normalizeTarget( value ) {
	return value.trim().replace( /[\s_/]+/g, '-' ).replace( /-+/g, '-' ).replace( /^-|-$/g, '' ).toLowerCase();
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
	} else if ( 2 <= segments.length && kebab( segments[ segments.length - 2 ] ) === kebab( base ) ) {
		slugSegments = directories;
		rank         = 2;
	}

	return { slug: slugSegments.map( kebab ).join( '/' ) || 'home', rank };
}

/**
 * List every file under a folder as POSIX paths relative to the docs folder.
 *
 * @param {string} directory
 * @returns {string[]}
 */
function listFiles( directory ) {
	const files = [];

	for ( const name of readdirSync( directory ).sort() ) {
		const path = join( directory, name );

		if ( statSync( path ).isDirectory() ) {
			files.push( ...listFiles( path ) );
		} else {
			files.push( relative( docsPath, path ).split( sep ).join( '/' ) );
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
	const match      = normalized.match( /^---\s*\n([\s\S]*?)\n---\s*\n?/ );

	if ( ! match ) {
		return { fields: [], body: normalized };
	}

	const fields = [];

	for ( const line of match[1].split( '\n' ) ) {
		const pair = line.match( /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/ );

		if ( pair ) {
			fields.push( [ pair[1].toLowerCase(), pair[2].trim().replace( /^["']|["']$/g, '' ) ] );
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
 * Build the migration plan and apply it when --write is set.
 */
function migrate() {
	if ( ! existsSync( docsPath ) ) {
		console.error( `No docs folder at ${ docsPath }.` );
		process.exit( 2 );
	}

	const oldFiles  = listFiles( docsPath ).filter( ( file ) => ! basename( file ).startsWith( '.' ) );
	const pageFiles = oldFiles.filter( ( file ) => file.toLowerCase().endsWith( '.md' ) );

	const published = new Map();

	for ( const file of pageFiles ) {
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

	const moves   = new Map();
	const claimed = new Map();
	const dropped = [];

	const ordered = [ ...oldFiles ].sort( ( a, b ) => {
		const rankA = a.endsWith( '.md' ) ? importerSlug( a ).rank : 0;
		const rankB = b.endsWith( '.md' ) ? importerSlug( b ).rank : 0;

		if ( rankA !== rankB ) {
			return rankB - rankA;
		}

		const keepsNameA = targetPath( a ).path === a ? 0 : 1;
		const keepsNameB = targetPath( b ).path === b ? 0 : 1;

		return keepsNameA - keepsNameB;
	} );

	for ( const file of ordered ) {
		const target = targetPath( file );
		const key    = `${ target.planning ? 'planning' : 'docs' }:${ target.path }`;

		if ( claimed.has( key ) ) {
			const winner = claimed.get( key );
			const isShadowedLanding = file.endsWith( '.md' ) && published.get( importerSlug( file ).slug )?.file !== file;

			if ( isShadowedLanding && importerSlug( winner ).slug === importerSlug( file ).slug ) {
				dropped.push( file );
				note( `Dropped ${ file }: the docs site already published ${ winner } in its place, so this copy was never shown. Check it for anything worth keeping.` );
			} else {
				moves.set( file, { ...targetPath( file ), path: file, planning: false, conflict: true } );
				note( `Left ${ file } in place: ${ target.path } is already taken by ${ winner }. Merge the two by hand.` );
			}

			continue;
		}

		claimed.set( key, file );
		moves.set( file, target );
	}

	const newPathOf = ( oldFile ) => {
		const move = moves.get( oldFile );

		return move && ! move.planning ? move.path : null;
	};

	const resolveOldTarget = ( currentOld, target ) => {
		const clean = decodeURI( target ).replace( /^\.\//, '' );

		const direct = posix.normalize( posix.join( posix.dirname( currentOld ), clean ) );

		for ( const candidate of [ direct, `${ direct }.md`, `${ direct }/${ posix.basename( direct ) }.md` ] ) {
			if ( oldFiles.includes( candidate ) ) {
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

		const inRepo = posix.normalize( posix.join( 'docs', posix.dirname( currentOld ), decodeURI( target ) ) );

		if ( inRepo.startsWith( '..' ) || inRepo.startsWith( 'docs/' ) || ! existsSync( join( repoRoot, inRepo ) ) ) {
			return null;
		}

		return `${ repositoryUrl }/${ inRepo }`;
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
	let linksFixed   = 0;
	let linksBroken  = 0;
	let fencesTagged = 0;

	for ( const oldFile of pageFiles ) {
		const newFile = newPathOf( oldFile );

		if ( null === newFile || dropped.includes( oldFile ) ) {
			continue;
		}

		const { fields, body } = splitPage( readFileSync( join( docsPath, oldFile ), 'utf8' ) );
		const lines            = body.split( '\n' );
		const output           = [];
		let fence              = null;
		let fenceStart         = -1;
		let h1Count            = 0;
		let firstH1            = null;

		for ( let index = 0; index < lines.length; index++ ) {
			let line         = lines[ index ];
			const fenceMatch = line.match( /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)(.*)$/ );

			if ( fenceMatch ) {
				if ( null === fence ) {
					fence      = fenceMatch[2];
					fenceStart = output.length;
					output.push( line );

					continue;
				}

				if ( fenceMatch[2][0] === fence[0] && fenceMatch[2].length >= fence.length && '' === fenceMatch[3] ) {
					const opening = output[ fenceStart ].match( /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)(.*)$/ );

					if ( '' === opening[3] ) {
						const language        = guessLanguage( output.slice( fenceStart + 1 ) );
						output[ fenceStart ] = `${ opening[1] }${ opening[2] }${ language }`;
						fencesTagged++;
					}

					fence = null;
				}

				output.push( line );

				continue;
			}

			if ( null !== fence ) {
				output.push( line );

				continue;
			}

			const alert = line.match( /^(\s{0,3}>)\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i );

			if ( alert && /^\s{0,3}>/.test( lines[ index + 1 ] ?? '' ) ) {
				const next = lines[ ++index ].replace( /^\s{0,3}>\s?/, '' );
				output.push( `${ alert[1] } **${ ALERT_LABELS[ alert[2].toUpperCase() ] }:** ${ next }` );

				continue;
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

			line = line.replace( /(!?)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?((?:\s+"[^"]*")?)\s*\)/g, ( whole, bang, text, target, linkTitle ) => {
				if ( /^(https?:|mailto:|tel:|#)/i.test( target ) ) {
					return whole;
				}

				const [ path, ...rest ] = target.split( /(?=[#?])/ );
				const suffix            = rest.join( '' );

				if ( '' === path ) {
					return whole;
				}

				const found = resolveOldTarget( oldFile, path );

				if ( ! found || ! newPathOf( found ) ) {
					const external = sourceUrl( oldFile, path );

					if ( external ) {
						linksFixed++;

						return `${ bang }[${ text }](${ external }${ suffix }${ linkTitle })`;
					}

					linksBroken++;

					return whole;
				}

				const link = `${ relativeLink( newFile, newPathOf( found ) ) }${ suffix }`;

				if ( ! bang ) {
					recordLinkOrder( newFile, newPathOf( found ) );
				}

				if ( link !== target ) {
					linksFixed++;
				}

				return `${ bang }[${ text }](${ link }${ linkTitle })`;
			} );

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
		const existing  = ( page ) => {
			const value = rewritten.get( page )?.fields.find( ( [ key ] ) => 'menu_order' === key )?.[1];

			return /^-?\d+$/.test( value ?? '' ) ? Number( value ) : null;
		};

		const allHaveOrder = pages.every( ( page ) => null !== existing( page ) );

		return [ ...pages ].sort( ( a, b ) => {
			if ( allHaveOrder && existing( a ) !== existing( b ) ) {
				return existing( a ) - existing( b );
			}

			const positionA = preferred.findIndex( ( target ) => target === a || target.startsWith( a.replace( /\.md$/, '/' ) ) );
			const positionB = preferred.findIndex( ( target ) => target === b || target.startsWith( b.replace( /\.md$/, '/' ) ) );

			if ( positionA !== positionB ) {
				return ( -1 === positionA ? Infinity : positionA ) - ( -1 === positionB ? Infinity : positionB );
			}

			return a.localeCompare( b );
		} ).map( ( page, index ) => [ page, start + ( index * step ) ] );
	};

	const menuOrders = new Map();
	const topLevel   = [ ...rewritten.keys() ].filter( ( page ) => ! page.includes( '/' ) );
	const custom     = topLevel.filter( ( page ) => undefined === STANDARD_SLOTS[ page.replace( /\.md$/, '' ) ] );

	for ( const page of topLevel ) {
		const slot = STANDARD_SLOTS[ page.replace( /\.md$/, '' ) ];

		if ( undefined !== slot ) {
			menuOrders.set( page, slot );
		}
	}

	const customStep = 0 === custom.length ? 5 : Math.max( 1, Math.min( 5, Math.floor( 39 / custom.length ) ) );

	for ( const [ page, order ] of assignOrder( custom, 'home.md', 40, customStep ) ) {
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

	const contents = new Map();

	for ( const [ newFile, page ] of rewritten ) {
		const stem      = posix.basename( newFile, '.md' );
		const fieldMap  = new Map( page.fields );
		const h1Line    = null === page.firstH1 ? null : page.lines[ page.firstH1 ];
		const h1Text    = h1Line ? h1Line.replace( /^#\s+/, '' ).replace( /\s+#*\s*$/, '' ).trim() : null;
		const topLevel  = ! newFile.includes( '/' );
		const title     = ( topLevel && STANDARD_TITLES[ stem ] ) || fieldMap.get( 'title' ) || h1Text || humanize( stem );
		const oldSlug   = importerSlug( page.oldFile ).slug;
		const newSlug   = newFile.replace( /\.md$/, '' );
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

	const renamed  = [ ...moves ].filter( ( [ from, move ] ) => move.path !== from || move.planning );
	const planning = renamed.filter( ( [ , move ] ) => move.planning );

	console.log( `Docs migration plan for ${ relative( process.cwd(), docsPath ) || '.' }${ write ? '' : ' (dry run)' }\n` );

	for ( const [ from, move ] of renamed ) {
		console.log( `  ${ from } → ${ move.planning ? `.planning/${ move.path }` : move.path }` );
	}

	for ( const file of dropped ) {
		console.log( `  ${ file } → (removed, never published)` );
	}

	console.log( `\n  ${ renamed.length - planning.length } page(s) renamed, ${ planning.length } internal file(s) moved to .planning/, ${ dropped.length } shadowed page(s) removed.` );
	console.log( `  ${ contents.size } page(s) normalized, ${ linksFixed } link(s) rewritten, ${ fencesTagged } code block(s) tagged.` );

	if ( 0 < linksBroken ) {
		note( `${ linksBroken } link(s) couldn't be resolved to a page and were left as they are. docs-lint will list them.` );
	}

	if ( notes.length ) {
		console.log( '\nNeeds a look:' );

		for ( const message of notes ) {
			console.log( `  - ${ message }` );
		}
	}

	if ( ! write ) {
		console.log( '\nRun again with --write to apply.' );

		return;
	}

	const staging = join( repoRoot, '.docs-migrate-staging' );
	rmSync( staging, { recursive: true, force: true } );

	for ( const [ from, move ] of moves ) {
		const destination = move.planning ? join( staging, 'planning', move.path ) : join( staging, 'docs', move.path );
		mkdirSync( dirname( destination ), { recursive: true } );

		if ( contents.has( move.path ) && ! move.planning && from.toLowerCase().endsWith( '.md' ) && rewritten.get( move.path )?.oldFile === from ) {
			writeFileSync( destination, contents.get( move.path ) );
		} else {
			renameSync( join( docsPath, from ), destination );
		}
	}

	for ( const file of oldFiles ) {
		rmSync( join( docsPath, file ), { force: true } );
	}

	const leftovers = listFiles( docsPath );

	rmSync( docsPath, { recursive: true, force: true } );
	renameSync( join( staging, 'docs' ), docsPath );

	for ( const leftover of leftovers ) {
		console.log( `  Removed ${ leftover }, which the standard doesn't need. Restore it from git if it matters.` );
	}

	if ( existsSync( join( staging, 'planning' ) ) ) {
		const planningRoot = join( repoRoot, '.planning' );

		for ( const file of listFilesUnder( join( staging, 'planning' ) ) ) {
			const destination = join( planningRoot, file );
			mkdirSync( dirname( destination ), { recursive: true } );
			renameSync( join( staging, 'planning', file ), destination );
		}
	}

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

	for ( const name of readdirSync( directory ) ) {
		const path = join( directory, name );

		if ( statSync( path ).isDirectory() ) {
			files.push( ...listFilesUnder( path ).map( ( file ) => join( name, file ) ) );
		} else {
			files.push( name );
		}
	}

	return files;
}

migrate();
