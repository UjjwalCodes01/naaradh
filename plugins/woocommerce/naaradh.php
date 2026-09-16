<?php
/**
 * Plugin Name:       Naaradh — AI calls for WooCommerce
 * Plugin URI:        https://naaradh.com
 * Description:       Confirms cash-on-delivery orders, recovers abandoned carts and answers your support line with an AI voice agent. Calls are placed by Naaradh (naaradh.com) through its compliance layer; this plugin only reports orders and carts and writes the results back as order notes.
 * Version:           0.1.0
 * Requires at least: 6.4
 * Requires PHP:      8.1
 * Author:            Naaradh
 * Author URI:        https://naaradh.com
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       naaradh
 * Domain Path:       /languages
 * WC requires at least: 8.0
 * WC tested up to:   9.4
 *
 * Naaradh for WooCommerce (ADR-0011 §3).
 *
 * Four things, all server-side — the API key never reaches a browser:
 *   1. a consent checkbox at checkout, storing the WORDING VERSION on the order;
 *   2. COD orders → POST /v1/intents (a confirmation call);
 *   3. every order → PUT /v1/orders/{id} (the cache the support line answers from) and
 *      POST /v1/carts/{ref}/completed (so a queued recovery call stops);
 *   4. carts with a phone and a ticked box → PUT /v1/carts/{ref}.
 *
 * Results come back to a REST route that verifies Naaradh's webhook signature and writes an
 * order note. This plugin never cancels or edits an order by itself.
 *
 * @package Naaradh
 */

declare( strict_types = 1 );

defined( 'ABSPATH' ) || exit;

define( 'NAARADH_VERSION', '0.1.0' );
define( 'NAARADH_PLUGIN_FILE', __FILE__ );
define( 'NAARADH_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );

require_once NAARADH_PLUGIN_DIR . 'includes/class-naaradh-settings.php';
require_once NAARADH_PLUGIN_DIR . 'includes/class-naaradh-client.php';
require_once NAARADH_PLUGIN_DIR . 'includes/class-naaradh-consent.php';
require_once NAARADH_PLUGIN_DIR . 'includes/class-naaradh-orders.php';
require_once NAARADH_PLUGIN_DIR . 'includes/class-naaradh-carts.php';
require_once NAARADH_PLUGIN_DIR . 'includes/class-naaradh-webhook.php';

/**
 * Boots the plugin once WooCommerce is known to be there.
 */
function naaradh_init(): void {
	load_plugin_textdomain( 'naaradh', false, dirname( plugin_basename( NAARADH_PLUGIN_FILE ) ) . '/languages' );

	if ( ! class_exists( 'WooCommerce' ) ) {
		add_action(
			'admin_notices',
			static function (): void {
				echo '<div class="notice notice-error"><p>';
				echo esc_html__( 'Naaradh needs WooCommerce to be active.', 'naaradh' );
				echo '</p></div>';
			}
		);
		return;
	}

	Naaradh_Settings::init();
	Naaradh_Consent::init();
	Naaradh_Orders::init();
	Naaradh_Carts::init();
	Naaradh_Webhook::init();
}
add_action( 'plugins_loaded', 'naaradh_init' );

/** HPOS (custom order tables) compatibility — this plugin uses the CRUD API only. */
add_action(
	'before_woocommerce_init',
	static function (): void {
		if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
			\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', NAARADH_PLUGIN_FILE, true );
		}
	}
);

register_deactivation_hook(
	NAARADH_PLUGIN_FILE,
	static function (): void {
		wp_clear_scheduled_hook( 'naaradh_sweep_carts' );
	}
);
