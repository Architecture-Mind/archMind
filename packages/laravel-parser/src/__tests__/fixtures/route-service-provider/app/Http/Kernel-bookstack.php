<?php

namespace App\Http;

use Illuminate\Foundation\Http\Kernel as HttpKernel;

class Kernel extends HttpKernel
{
    protected $middlewareGroups = [
        'web' => [
            \App\Http\Middleware\EncryptCookies::class,
        ],

        // BookStack-shaped 'api' group: a real auth middleware sits inside it, so any
        // route file wrapped in this group in RouteServiceProvider.php is authenticated
        // even though no route in that file declares ->middleware(...) inline.
        'api' => [
            \App\Http\Middleware\ApiAuthenticate::class,
            'throttle:api',
            \Illuminate\Routing\Middleware\SubstituteBindings::class,
        ],
    ];
}
