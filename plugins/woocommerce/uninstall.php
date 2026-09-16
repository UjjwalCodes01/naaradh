<?php
/**
 * Removes the plugin's options on uninstall. Order notes and order meta are the merchant's
 * records and are left alone.
 *
 * @package Naaradh
 */

declare( strict_types = 1 );

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

foreach (
	array(
		'naaradh_api_key',
		'naaradh_api_base',
		'naaradh_cod_calls',
		'naaradh_cart_calls',
		'naaradh_consent_text',
		'naaradh_consent_version',
		'naaradh_webhook_secret',
		'naaradh_last_error',
	) as $option
) {
	delete_option( $option );
}
