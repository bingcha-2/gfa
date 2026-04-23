#!/bin/bash
# Query NewAPI options from DB
docker exec postgres psql -U root -d new-api -t -c "SELECT key || ' = ' || value FROM options ORDER BY key;"
