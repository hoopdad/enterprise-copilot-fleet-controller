echo "Starting at $(date)"
mkdir laf-track-harness
cp init-pattern.yml laf-track-harness/
cd laf-track-harness/
../../enterprise-copilot-fleet-controller/scripts/init.sh -c init-pattern.yml | tee  -a output.txt
echo "Ending at $(date)"