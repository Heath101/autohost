var path = require( 'path' );
var _ = require( 'lodash' );
var parseUrl = require( 'parseurl' );
var qs = require( 'qs' );
var queryparse = qs.parse;
var express = require( 'express' );
var http = require( 'http' );
var debug = require( 'debug' )( 'autohost:http-transport' );
var Router = express.Router;
var expreq = express.request; //jshint ignore:line
var expres = express.response; //jshint ignore:line
var middleware, routes, paths, request, config, metrics, middlewareLib;

var wrapper;

function buildUrl() {
	var idx = 0,
		cleaned = [],
		segment;
	while( idx < arguments.length ) {
		segment = arguments[ idx ];
		if( segment.substr( 0, 1 ) === '/' ) {
			segment = segment.substr( 1 );
		}
		if( segment.substr( segment.length-1, 1 ) === '/' ) {
			segment = segment.substring( 0, segment.length - 1 );
		}
		if( !_.isEmpty( segment ) ) {
			cleaned.push( segment );
		}
		idx ++;
	}
	return cleaned.length ? '/' + cleaned.join( '/' ) : '';
}

function createMiddlewareStack() {
	var router = new Router();
	router
		.use( expressInit )
		.use( queryParser );
	_.each( middleware, function( m ) {
		m( router );
	} );
	return router;
}

function createAuthMiddlewareStack() {
	var router = new Router().use( expressInit ).use( queryParser );
	_.each( middleware, function( m ) {
		m( router );
	} );
	if( wrapper.passport ) {
		_.each( wrapper.passport.getMiddleware( '/' ), function( m ) {
			router.use( m.path, m.fn );
		} );
	}
	return router;
}

// adaptation of express's initializing middleware
// the original approach breaks engine-io
function expressInit( req, res, next ) { // jshint ignore:line
    req.next = next;
    req.context = {};
    // patching this according to how express does it
    /* jshint ignore:start */
    req.__proto__ = expreq;
    res.__proto__ = expres;
    /* jshint ignore:end */
    next();
}

function initialize() {
	var cwd = process.cwd();
	var public = path.resolve( cwd, ( config.static || './public' ) );
	config.tmp = path.resolve( cwd, ( config.temp || './tmp' ) );

	wrapper.static( '/', public );

	// apply user-supplied middleware
	_.each( middleware, function( m ) { m( wrapper.app ); } );
	_.each( routes, function( r ) { r(); } );
	_.each( paths, function( p ) { p(); } );
}

// intercept and apply prefix to url if one exists
function prefix( fn ) {
	return function() {
		var args = Array.prototype.slice.call( arguments );
		if( config.urlPrefix ) {
			var url = args.shift();
			var prefixIndex = url.indexOf( config.urlPrefix );
			var prefix = prefixIndex === 0 ? '' : config.urlPrefix;
			args.unshift( buildUrl( prefix, url ) );
		}
		fn.apply( null, args );
	};
}

// Internal query-parsing middleware from express
// (not exposed, so copied here)
function queryParser( req, res, next ) { // jshint ignore:line
	if ( !req.query ) {
		var val = parseUrl( req ).query;
		req.query = queryparse( val );
	}
	next();
}

// this might be the worst thing to ever happen to anything ever
// this is adapted directly from express layer.match
function parseAhead( router, req, done ){
  var idx = 0;
  var stack = router.stack;
  var params = {};
  var method = req.method ? req.method.toLowerCase() : undefined;
  next();

  function next() {
	var layer = stack[idx++];
	if (!layer) {
		// strip dangling query params
		params = _.transform( params, function( acc, v, k ) { 
			acc[ k ] = v.split( '?' )[ 0 ]; return acc; 
		}, {} );
		return done( params );
	}

	if (layer.method && layer.method !== method) {
		return next();
	}
  	layer.match( req.originalUrl );
  	params = _.merge( params, layer.params );
  	next();
  }
}

function preprocessPathVariables( req, res, next ) {
	parseAhead( wrapper.app._router, req, function( params ) {
		var original = req.param;
		req.preparams = params;
		req.param = function( name, dflt ) {
			return params[ name ] || original( name, dflt ); 
		};
		next();
	} );
}

function registerMiddleware( filter, callback ) {
	middleware.push( function( target ) {
		debug( 'MIDDLEWARE: %s mounted at %s', ( callback.name || 'anonymous' ), filter );
		target.use( filter, callback );
	} );
}

function registerRoute( url, verb, callback ) {
	verb = verb.toLowerCase();
	verb = verb === 'all' || verb === 'any' ? 'all' : verb;
	var errors = [ url, verb, 'errors' ].join( '.' );
	routes.push( function() {
		debug( 'ROUTE: %s %s -> %s', verb, url, ( callback.name || 'anonymous' ) );
		wrapper.app[ verb ]( url, function( req, res ) {
			try {
				callback( req, res );
			} catch ( err ) {
				metrics.meter( errors ).record();
				debug( 'ERROR! route: %s %s failed with %s', verb, url, err.stack );
			}
		} );
	} );
}

function registerStaticPath( url, filePath ) { // jshint ignore:line
	paths.push( function() {
		var target = path.resolve( filePath );
		debug( 'STATIC: %s -> %s', url, target );
		wrapper.app.use( url, express.static( target ) );
	} );
}

function start() {
	initialize();
	wrapper.server = http.createServer( wrapper.app );
	wrapper.server.listen( config.port || 8800 );
	console.log( 'autohost listening on port ', ( config.port || 8800 ) );
}

function stop() {
	if( wrapper.server ) {
		wrapper.server.close();
		wrapper.server = undefined;
	}
}

wrapper = {
	buildUrl: buildUrl,
	getMiddleware: createMiddlewareStack,
	getAuthMiddleware: createAuthMiddlewareStack,
	middleware: registerMiddleware,
	route: prefix( registerRoute ),
	start: start,
	static: prefix( registerStaticPath ),
	server: undefined,
	app: undefined,
	passport: undefined,
	stop: stop
};

module.exports = function( cfg, req, pass, mw, metric ) {
	middleware = [];
	routes = [];
	paths = [];
	config = cfg;
	metrics = metric;
	request = req;
	wrapper.passport = pass;
	wrapper.app = express();
	middlewareLib = mw;

	// if using an auth strategy, move cookie and session middleware before passport middleware
	// to take advantage of sessions/cookies and avoid authenticating on every request
	if( pass ) {
		middlewareLib.useCookies( registerMiddleware );
		middlewareLib.useSession( registerMiddleware );
		wrapper.passport.wireupPassport( wrapper );
	}

	if( cfg.parseAhead ) {
		middleware.push( function( router ) {
			router.use( preprocessPathVariables );
		} );
	}
	// prime middleware with defaults
	middlewareLib.attach( registerMiddleware, pass !== undefined );
	return wrapper;
};