/**
 * Regression tests for docs-lint.mjs's hook and helper coverage check.
 *
 * Run with: node --test scripts/
 *
 * @since 1.1.0
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

const linter = join( dirname( fileURLToPath( import.meta.url ) ), 'docs-lint.mjs' );

let root;
let output;

/**
 * Write a fixture file, creating its folders.
 *
 * @param {string} path
 * @param {string} content
 */
function put( path, content ) {
	mkdirSync( dirname( join( root, path ) ), { recursive: true } );
	writeFileSync( join( root, path ), content );
}

before( () => {
	root = mkdtempSync( join( tmpdir(), 'docs-lint-' ) );

	put( 'docs/reference.md', [
		'---',
		'title: Reference',
		'menu_order: 85',
		'---',
		'',
		'# Reference',
		'',
		'- `ap.saved.after`',
		'- `ap.alpha.fired`',
		'- `ap.documented`',
		'- `ap.{screen}.saved`',
		'- `apPublicHelper()`',
		'',
	].join( '\n' ) );

	put( 'composer.json', JSON.stringify( { autoload: { files: [ 'src/helpers.php', 'bootstrap/helpers.php' ] } } ) );

	put( 'src/helpers.php', [
		'<?php',
		'',
		'/** Documented. */',
		'function apPublicHelper(): void {}',
		'',
		'/**',
		' * Not for apps.',
		' *',
		' * @internal',
		' */',
		'function apInternalHelper(): void {}',
		'',
		'/** Public but missing from the docs. */',
		'function apMissingHelper(): void {}',
		'',
	].join( '\n' ) );

	put( 'bootstrap/helpers.php', '<?php\n' );

	put( 'src/Alpha/Hooks.php', [
		'<?php',
		'',
		'namespace Fixture\\Alpha;',
		'',
		'class Hooks',
		'{',
		"\tpublic const FIRED = 'ap.alpha.fired';",
		'',
		'\tpublic function run(): void',
		'\t{',
		'\t\tdoAction( self::FIRED );',
		'\t}',
		'}',
		'',
	].join( '\n' ) );

	put( 'src/Beta/Hooks.php', [
		'<?php',
		'',
		'namespace Fixture\\Beta;',
		'',
		'class Hooks',
		'{',
		"\tpublic const FIRED = 'ap.beta.fired';",
		'',
		'\tpublic function run(): void',
		'\t{',
		'\t\tdoAction( self::FIRED );',
		'\t}',
		'}',
		'',
	].join( '\n' ) );

	put( 'src/Calls.php', [
		'<?php',
		'',
		'namespace Fixture;',
		'',
		'use Fixture\\Beta\\Hooks as BetaHooks;',
		'',
		'class Calls',
		'{',
		'\tpublic function run( string $screen ): void',
		'\t{',
		"\t\tdoAction( 'ap.saved' );",
		"\t\tdoAction( 'ap.documented' );",
		'\t\tdoAction( "ap.$screen.saved" );',
		"\t\twork(); // doAction( 'ap.trailing.comment' );",
		'\t\t/*',
		"\t\tdoAction( 'ap.block.comment' );",
		'\t\t*/',
		"\t\t$url = 'https://example.com'; doAction( 'ap.after.string' );",
		'\t\tdoAction( BetaHooks::FIRED );',
		'\t}',
		'}',
		'',
	].join( '\n' ) );

	put( 'resources/views/example.blade.php', [
		"{{-- @action('ap.blade.comment') --}}",
		"<p>Don't stop: @action('ap.blade.fired')</p>",
		'',
	].join( '\n' ) );

	const result = spawnSync( process.execPath, [ linter, join( root, 'docs' ) ], { cwd: root, encoding: 'utf8' } );

	output = result.stdout;
} );

after( () => {
	rmSync( root, { recursive: true, force: true } );
} );

/**
 * Whether the run warned that a hook isn't documented.
 *
 * @param {string} name
 * @returns {boolean}
 */
function warnsAboutHook( name ) {
	return output.includes( `Hook "${ name }" isn't documented` );
}

test( 'a hook whose name is only a prefix of a documented hook is reported', () => {
	assert.ok( warnsAboutHook( 'ap.saved' ) );
} );

test( 'documented hooks are not reported', () => {
	assert.ok( ! warnsAboutHook( 'ap.documented' ) );
	assert.ok( ! warnsAboutHook( 'ap.alpha.fired' ) );
} );

test( 'self:: constants resolve against their own class, not a same-named class elsewhere', () => {
	assert.ok( warnsAboutHook( 'ap.beta.fired' ) );
	assert.match( output, /src\/Beta\/Hooks\.php:11 +Hook "ap\.beta\.fired"/ );
} );

test( 'interpolated hook names are skipped', () => {
	assert.ok( ! output.includes( '$screen' ) );
} );

test( 'hooks inside comments are skipped', () => {
	assert.ok( ! warnsAboutHook( 'ap.trailing.comment' ) );
	assert.ok( ! warnsAboutHook( 'ap.block.comment' ) );
	assert.ok( ! warnsAboutHook( 'ap.blade.comment' ) );
} );

test( 'hooks after strings and in Blade text are still found', () => {
	assert.ok( warnsAboutHook( 'ap.after.string' ) );
	assert.ok( warnsAboutHook( 'ap.blade.fired' ) );
} );

test( 'undocumented public helpers are reported, @internal ones are not', () => {
	assert.ok( output.includes( 'apMissingHelper() isn\'t documented' ) );
	assert.ok( ! output.includes( 'apInternalHelper()' ) );
	assert.ok( ! output.includes( 'apPublicHelper() isn\'t documented' ) );
} );

test( 'autoloaded helper files outside src/ are reported', () => {
	assert.match( output, /bootstrap\/helpers\.php +Autoloaded helper files belong in src\// );
} );
