import * as cdk from "@aws-cdk/core";
import eks = require("@aws-cdk/aws-eks");
import ec2 = require("@aws-cdk/aws-ec2");
import iam = require("@aws-cdk/aws-iam");
import * as ssm from "@aws-cdk/aws-ssm";

import { EksManagedNodeGroup } from "./infrastructure/eks-mng";
import { AWSLoadBalancerController } from "./infrastructure/aws-load-balancer-controller";
import { ExternalDNS } from "./infrastructure/external-dns";
import { ClusterAutoscaler } from "./infrastructure/cluster-autoscaler";
import { ContainerInsights } from "./infrastructure/container-insights";
import { Calico } from "./infrastructure/calico";
import { Prometheus } from "./infrastructure/prometheus";
import { Echoserver } from "./application/echoserver";

export interface EksClusterStackProps extends cdk.StackProps {
  clusterVersion: eks.KubernetesVersion;
  nameSuffix: string;
}

export class EksClusterStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: EksClusterStackProps) {
    super(scope, id, props);

    const vpcId = ssm.StringParameter.valueFromLookup(this, '/lz/vpc/id');  
    
    const privateSubnet1a = ssm.StringParameter.valueFromLookup(this, '/lz/vpc/app-subnet-1a/id'); 
    const privateSubnet2a = ssm.StringParameter.valueFromLookup(this, '/lz/vpc/app-subnet-2a/id'); 
    const privateSubnet3a = ssm.StringParameter.valueFromLookup(this, '/lz/vpc/app-subnet-3a/id'); 
    
    const subnetFilter = ec2.SubnetFilter.byIds([privateSubnet1a, privateSubnet2a, privateSubnet3a]);
    
    let vpc_subnets_2: ec2.SubnetSelection = {
      subnetFilters: [subnetFilter],
    };
    
    let vpc_subnets_1: ec2.SubnetSelection = {
      subnetType: ec2.SubnetType.PRIVATE,
    };
    
    const vpc = ec2.Vpc.fromLookup(this, 'ImportVPC',{
      isDefault: false,
      vpcId: vpcId,
    });
    
    let selectedSubnets;

    // Check if the correct subnets are resolved after CDK has refreshed its context (i.e. after 
    // the vpcId is no longer the dummy vpc id)
    if (vpc.vpcId != 'vpc-12345') {
      selectedSubnets = vpc_subnets_2
    } else {
      // Otherwise eks.Cluster would complain
      selectedSubnets = vpc_subnets_1
    }

    const cluster = new eks.Cluster(this, `acme-${props.nameSuffix}`, {
      clusterName: `acme-${props.nameSuffix}`,
      version: props.clusterVersion,
      defaultCapacity: 0,
      vpc,
      vpcSubnets: [selectedSubnets],
      endpointAccess: eks.EndpointAccess.PRIVATE, // No access outside of your VPC.
      placeClusterHandlerInVpc: true,
    });

    const aud = `${cluster.clusterOpenIdConnectIssuer}:aud`;
    const sub = `${cluster.clusterOpenIdConnectIssuer}:sub`;

    const conditions = new cdk.CfnJson(this, "awsNodeOIDCCondition", {
      value: {
        [aud]: "sts.amazonaws.com",
        [sub]: "system:serviceaccount:kube-system:aws-node",
      },
    });

    const awsNodeIamRole = new iam.Role(this, "awsNodeIamRole", {
      assumedBy: new iam.WebIdentityPrincipal(
        `arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:oidc-provider/${cluster.clusterOpenIdConnectIssuer}`
      ).withConditions({
        StringEquals: conditions,
      }),
    });

    awsNodeIamRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonEKS_CNI_Policy")
    );

    const awsNodeCniPatch = new eks.KubernetesPatch(
      this,
      "serviceAccount/aws-node",
      {
        cluster,
        resourceName: "serviceAccount/aws-node",
        resourceNamespace: "kube-system",
        applyPatch: {
          metadata: {
            annotations: {
              "eks.amazonaws.com/role-arn": awsNodeIamRole.roleArn,
            },
          },
        },
        restorePatch: {
          metadata: {
            annotations: {},
          },
        },
      }
    );
    
      const awsNodeCniPatchCustomNetwork = new eks.KubernetesPatch(
      this,
      "daemonSet/aws-node",
      {
        cluster,
        resourceName: "daemonSet/aws-node",
        resourceNamespace: "kube-system",
        applyPatch: {
          spec: {
            containers: [{
              env: [
                {
                  "name": "AWS_VPC_K8S_CNI_CUSTOM_NETWORK_CFG",
                  "value": "true"
                },
                {
                  "name": "ENI_CONFIG_LABEL_DEF",
                  "value": "topology.kubernetes.io/zone"
                }
              ]
            }]
          }
        },
        restorePatch: {
          metadata: {
            annotations: {},
          },
        },
      }
    );
    
    const eksMng = new EksManagedNodeGroup(this, "EksManagedNodeGroup", {
      cluster: cluster,
      nameSuffix: props.nameSuffix,
    });

    eksMng.node.addDependency(awsNodeCniPatch);
    eksMng.node.addDependency(awsNodeCniPatchCustomNetwork);

    new AWSLoadBalancerController(this, "AWSLoadBalancerController", {
      cluster: cluster,
    });

    const hostZoneId = ssm.StringParameter.valueForStringParameter(
      this,
      "/eks-cdk-pipelines/hostZoneId"
    );

    const zoneName = ssm.StringParameter.valueForStringParameter(
      this,
      "/eks-cdk-pipelines/zoneName"
    );

    new ExternalDNS(this, "ExternalDNS", {
      cluster: cluster,
      hostZoneId: hostZoneId,
      domainFilters: [`${props.nameSuffix}.${zoneName}`],
    });

    new ClusterAutoscaler(this, "ClusterAutoscaler", {
      cluster: cluster,
    });

    new ContainerInsights(this, "ContainerInsights", {
      cluster: cluster,
    });

    new Calico(this, "Calico", {
      cluster: cluster,
    });

    new Prometheus(this, "Prometheus", {
      cluster: cluster,
    });

    new Echoserver(this, "EchoServer", {
      cluster: cluster,
      nameSuffix: props.nameSuffix,
      domainName: zoneName,
    });
  }
}
