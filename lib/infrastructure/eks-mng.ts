import * as cdk from "@aws-cdk/core";
import eks = require("@aws-cdk/aws-eks");
import iam = require("@aws-cdk/aws-iam");
import ec2 = require("@aws-cdk/aws-ec2");

import * as ssm from "@aws-cdk/aws-ssm";

export interface EksManagedNodeGroupProps {
  cluster: eks.Cluster;
  nameSuffix: string;
}

export class EksManagedNodeGroup extends cdk.Construct {
  constructor(
    scope: cdk.Construct,
    id: string,
    props: EksManagedNodeGroupProps
  ) {
    super(scope, id);

    const lt = new ec2.CfnLaunchTemplate(this, "SSMLaunchTemplate", {
      launchTemplateData: {
        instanceType: "t3a.medium",
        
        tagSpecifications: [
          {
            resourceType: "instance",
            tags: [
              { key: "Name", value: `app-${props.nameSuffix}` },
              { key: "Environment", value: props.nameSuffix },
            ],
          },
          {
            resourceType: "volume",
            tags: [{ key: "Environment", value: props.nameSuffix }],
          },
        ],
      },
    });


    const nodeRole = new iam.Role(this, "EksNodeRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
    });

    nodeRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonEKSWorkerNodePolicy")
    );
    nodeRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "AmazonEC2ContainerRegistryReadOnly"
      )
    );
    nodeRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")
    );

    const privateSubnet1a = ssm.StringParameter.valueFromLookup(this, '/lz/vpc/app-subnet-1a/id'); 
    const privateSubnet2a = ssm.StringParameter.valueFromLookup(this, '/lz/vpc/app-subnet-2a/id'); 
    const privateSubnet3a = ssm.StringParameter.valueFromLookup(this, '/lz/vpc/app-subnet-3a/id'); 
    
    const subnetFilter = ec2.SubnetFilter.byIds([privateSubnet1a, privateSubnet2a, privateSubnet3a]);
    
    const vpc_subnets : ec2.SubnetSelection = {
      subnetFilters: [subnetFilter],
    };
    
    const userData = ec2.UserData.forLinux();
    
    userData.addCommands(
      'set -o xtrace',
      `/etc/eks/bootstrap.sh ${props.cluster.clusterName} --use-max-pods false --kubelet-extra-args '--max-pods=17'`,
    );

    props.cluster.addNodegroupCapacity("app-ng", {
      launchTemplateSpec: {
        id: lt.ref,
        version: lt.attrLatestVersionNumber,
      },
      minSize: 3,
      maxSize: 6,
      amiType: eks.NodegroupAmiType.AL2_X86_64,
      nodeRole: nodeRole,
      subnets: vpc_subnets,
    });
  }
}
