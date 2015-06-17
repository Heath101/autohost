module.exports = function( host ) {
	return {
		name: "ah",
		resources: "./public",
		actions: {
			"metrics": {
				url: "/metrics",
				method: "get",
				handle: function( /* envelope */ ) {
					var metrics = host.metrics.getReport();
					return { data: metrics };
				}
			}
		}
	};
};
