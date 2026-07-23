# Redirect Template Creator

Looking to create a new skill that will create a 301 redirect sheet between a production website, and a staging website used as a new website release. We need to ensure all URLs in the production sitemap are 301d

## Key features
1. Create 1:1 mapping between two sitemaps (new site, and current site)
1. If possible, create pattern redirects. but WE NEED TO BE SURE it wont mess with anything. Maybe add a sheet for raw 1:1, then a new one with patterns??
1. two columns: source, target. for the target, ask the user for the target URL (usually the staging site URL for testing purposes)
1. validate using code. Ensure there are no redirect loops, or chains.

## Example
staging: https://yalecordage.wpenginepowered.com/
prod: https://www.yalecordage.com/