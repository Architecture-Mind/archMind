<?php

use Illuminate\Support\Facades\Route;

// Module-style route registration (e.g. nwidart/laravel-modules): controllers
// referenced by bare string name are resolved under the group's namespace,
// not the App\Http\Controllers\ convention.
Route::namespace('Modules\Accounting\Http\Controllers')->group(function () {
    Route::get('/invoices', 'InvoiceController@index');

    // Relative sub-namespace controller string (Akaunting's `Sales\Invoices` pattern) —
    // a backslash-containing controller inside a namespace group is RELATIVE to that
    // group's namespace, not already a fully-qualified class name.
    Route::get('/invoices/sent', 'Sales\Invoices@markSent');
});

// Options-array group form: ['namespace' => '...']
Route::group(['namespace' => 'Modules\Billing\Http\Controllers'], function () {
    Route::get('/bills', 'BillController@index');
});

// No namespace group — falls back to the App\Http\Controllers\ convention.
Route::get('/health', 'HealthController@check');
