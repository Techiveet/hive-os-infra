<?php

use Modules\LandingTemplates\Models\LandingTemplate;
use Modules\LandingTemplates\Models\LandingTemplateAssignment;
use Modules\LandingTemplates\Models\TenantLandingInstance;
use Modules\Tenancy\Models\Tenant;

require __DIR__.'/../hive-os-backend/vendor/autoload.php';

$app = require __DIR__.'/../hive-os-backend/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$tenantId = 'lanouveil';
$template = LandingTemplate::on('central')->where('slug', 'restaurant-modern')->first();

if (! $template) {
    fwrite(STDERR, "restaurant-modern template not found. Seed BuilderCompatibleTemplatesSeeder first.\n");
    exit(1);
}

$version = $template->currentVersion;
$body = $version?->body ?? [];

$tenant = Tenant::on('central')->find($tenantId);
if (! $tenant) {
    fwrite(STDERR, "Tenant {$tenantId} not found.\n");
    exit(1);
}

$tenant->business_type = 'restaurant';
$tenant->landing_page_template = [
    'meta' => [
        'business_type' => 'restaurant',
        'business_label' => 'Restaurant',
        'template_key' => 'restaurant-modern',
        'template_label' => $template->name,
        'template_description' => $template->description,
        'is_custom' => true,
    ],
    'rendering' => $body['rendering'] ?? [
        'mode' => 'structured',
        'html' => '',
        'css' => '',
        'js' => '',
        'asset_base_url' => '',
    ],
    // Keep structured hospitality fields if present in body
    ...(is_array($body) ? array_diff_key($body, array_flip(['rendering', 'pages', 'code_files', 'project_data'])) : []),
];
$tenant->save();

LandingTemplateAssignment::on('central')->updateOrCreate([
    'landing_template_id' => $template->id,
    'assignable_type' => LandingTemplateAssignment::TYPE_TENANT,
    'assignable_id' => $tenantId,
], [
    'is_active' => true,
]);

TenantLandingInstance::on('central')->updateOrCreate(
    ['tenant_id' => $tenantId],
    [
        'landing_template_id' => $template->id,
        'landing_template_version_id' => $version?->id,
        'status' => TenantLandingInstance::STATUS_PUBLISHED,
        'content' => $body,
        'published_at' => now(),
    ]
);

echo "OK: {$tenantId} -> business_type=restaurant, template=restaurant-modern\n";
