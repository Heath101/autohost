var _ = require( 'lodash' );
var bodyParser = require( 'body-parser' );
var cookies = require( 'cookie-parser' );
var multer = require( 'multer' );
var metronic = require( '../metrics' );
var os = require( 'os' );
var hostName = os.hostname();
var log = require( '../log' )( 'autohost.access' );

function applyCookieMiddleware( state, attach ) {
	if ( !state.config.noCookies ) {
		attach( '/', state.cookieParser );
	}
}

function applyMiddleware( state, attach, hasAuth ) {
	// add a timer to track ALL requests
	attach( '/', requestMetrics.bind( undefined, state ), 'metrics' );

	if ( !hasAuth ) {
		applyCookieMiddleware( state, attach );
	}

	// turn on body parser unless turned off by the consumer
	if ( !state.config.noBody ) {
		attach( '/', bodyParser.urlencoded( { extended: false } ) );
		attach( '/', bodyParser.json() );
		attach( '/', bodyParser.json( { type: 'application/vnd.api+json' } ) );
		attach( '/', multer( {
			dest: state.config.tmp
		} ), 'multer' );
	}

	if ( !hasAuth ) {
		applySessionMiddleware( state, attach );
	}

	// turn on cross origin unless turned off by the consumer
	if ( !state.config.noCrossOrigin ) {
		attach( '/', crossOrigin.bind( undefined, state ) );
	}
}

function applySessionMiddleware( state, attach ) {
	// turn on sessions unless turned off by the consumer
	if ( !state.config.noSession ) {
		attach( '/', state.session );
	}
}

function crossOrigin( state, req, res, next ) {
	_.each( state.cors, function( val, header ) {
		res.header( header, val );
	});
	next();
}

function configure( state, config ) {
	state.config = config;
	var cookieDefaults = {
		path: '/',
		secure: false,
		maxAge: null
	};
	var sessionDefaults = {
		name: 'ah.sid',
		secret: 'autohostthing',
		resave: true,
		store: new state.sessionLib.MemoryStore(),
		saveUninitialized: true,
		rolling: false
	};
	var corsDefaults = {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Headers': 'X-Requested-With',
		'Access-Control-Allow-Methods': 'OPTIONS,POST,PUT,DELETE'
	};
	var cookieConfig = _.defaults( state.config.cookie || {}, cookieDefaults );
	var sessionConfig = _.defaults( state.config.session || {}, sessionDefaults );
	state.config.cors = _.defaults( state.config.cors || {}, corsDefaults );
	sessionConfig.cookie = cookieConfig;
	state.session = state.sessionLib( sessionConfig );
}

function requestMetrics( state, req, res, next ) {
	var ip;
	// for some edge cases, trying to access the ip/ips property
	// throws an exception, this work-around appears to avoid the
	// need to rely on try/catch
	if ( req.app ) {
		ip = req.ips.length ? req.ips[ 0 ] : req.ip ;
	} else {
		ip = req.headers[ 'X-Forwarded-For' ] || req.socket.remoteAddress;
	}
	req.context = {};
	res.setMaxListeners( 0 );
	var urlKey = req.url.slice( 1 ).replace( /[\/]/g, '-' ) + '-' + req.method.toLowerCase();
	var timer = state.metrics.timer( [ urlKey, 'http', 'duration' ] );

	res.once( 'finish', function() {
		var user = _.isObject( req.user ) ? ( req.user.name || req.user.username || req.user.id ) : 'anonymous';
		var method = req.method.toUpperCase();
		var read = req.connection.bytesRead;
		var readKB = read / 1024;
		var code = res.statusCode;
		var message = res.statusMessage;
		var sent = req.connection._bytesDispatched;
		var sentKB = sent ? sent / 1024 : 0;
		var url = req.url;
		var elapsed = timer.record( { name: 'HTTP_REQUEST_DURATION' } );

		var metricKey = req._metricKey;
		if ( metricKey ) {
			var resourceRequests = state.metrics.meter( 'requests', 'count', metricKey );
			var resourceIngress = state.metrics.meter( 'ingress', 'bytes', metricKey );
			var resourceEgress = state.metrics.meter( 'egress', 'bytes', metricKey );
			resourceRequests.record( 1, { name: 'HTTP_API_REQUESTS' } );
			resourceIngress.record( read, { name: 'HTTP_API_INGRESS' } );
			resourceEgress.record( sent, { name: 'HTTP_API_EGRESS' } );
		} else {
			var httpRequests = state.metrics.meter( [ urlKey, 'requests' ] );
			var httpIngress = state.metrics.meter( [ urlKey, 'ingress' ], 'bytes' );
			var httpEgress = state.metrics.meter( [ urlKey, 'egress' ], 'bytes' );
			httpRequests.record( 1, { name: 'HTTP_REQUESTS' } );
			httpIngress.record( read, { name: 'HTTP_INGRESS' } );
			httpEgress.record( sent, { name: 'HTTP_EGRESS' } );
		}

		log.info( '%s@%s %s (%d ms) [%s] %s %s (%d bytes) %s %s (%d bytes)',
			process.title,
			hostName,
			ip,
			elapsed,
			user || 'anonymous',
			method,
			url,
			read,
			code,
			message || '',
			sent
		);
	} );
	next();
}

module.exports = function( sessionLib ) {
	var state = {
		config: undefined,
		cookieParser: cookies(),
		metrics: metronic(),
		session: undefined,
		sessionLib: sessionLib
	};
	_.merge( state, {
		attach: applyMiddleware.bind( undefined, state ),
		configure: configure.bind( undefined, state ),
		useCookies: applyCookieMiddleware.bind( undefined, state ),
		useSession: applySessionMiddleware.bind( undefined, state ),
	} );
	return state;
};
